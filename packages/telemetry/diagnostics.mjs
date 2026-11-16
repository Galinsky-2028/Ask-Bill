/** Worker, queue and retention diagnostics (AB-103). Counts and ages only; no payloads or identities. */
const SQL=`SELECT
  (SELECT count(*) FROM ask_bill.jobs WHERE status IN ('queued','retry'))::int AS jobs_waiting,
  (SELECT count(*) FROM ask_bill.jobs WHERE status='leased')::int AS jobs_leased,
  (SELECT count(*) FROM ask_bill.jobs WHERE status='leased' AND lease_until<clock_timestamp())::int AS jobs_expired_leases,
  (SELECT count(*) FROM ask_bill.jobs WHERE status='dead')::int AS jobs_dead,
  (SELECT coalesce(extract(epoch FROM clock_timestamp()-min(available_at)),0) FROM ask_bill.jobs
     WHERE status IN ('queued','retry') AND available_at<=clock_timestamp())::float8 AS jobs_oldest_ready_seconds,
  (SELECT count(*) FROM ask_bill.outbox_events WHERE status='pending')::int AS outbox_pending,
  (SELECT count(*) FROM ask_bill.outbox_events WHERE status='failed')::int AS outbox_failed,
  (SELECT coalesce(extract(epoch FROM clock_timestamp()-min(created_at)),0) FROM ask_bill.outbox_events WHERE status='pending')::float8 AS outbox_oldest_pending_seconds,
  (SELECT count(*) FROM ask_bill.anonymous_sessions WHERE expires_at<clock_timestamp())::int AS retention_expired_sessions`;
/** Source freshness: hours since each active release's latest *official* retrieval (publisher uploads have no upstream). */
const FRESHNESS_SQL=`WITH active AS (
    SELECT rp.version_id FROM ask_bill.release_active a
    JOIN ask_bill.release_packs rp ON rp.publisher_id=a.publisher_id AND rp.bill_id=a.bill_id AND rp.id=a.release_id),
  latest AS (
    SELECT act.version_id,max(e.retrieved_at) FILTER (WHERE e.origin='official') AS official_at
    FROM active act LEFT JOIN ask_bill.source_import_events e ON e.version_id=act.version_id GROUP BY act.version_id)
  SELECT count(*)::int AS active_releases,
    count(*) FILTER (WHERE official_at IS NOT NULL)::int AS official_releases,
    count(*) FILTER (WHERE official_at IS NOT NULL AND official_at<clock_timestamp()-make_interval(hours=>$1))::int AS stale_official,
    coalesce(max(extract(epoch FROM clock_timestamp()-official_at)/3600),0)::float8 AS oldest_official_hours
  FROM latest`;

export async function collectDiagnostics(pool,publisherId,{staleAfterHours=168}={}){
  if(!Number.isSafeInteger(staleAfterHours)||staleAfterHours<1||staleAfterHours>8760)throw Error('DIAGNOSTICS_STALE_HOURS');
  const client=await pool.connect();
  try{
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('ask_bill.publisher_id',$1,true)",[publisherId]);
    const r=(await client.query(SQL)).rows[0],f=(await client.query(FRESHNESS_SQL,[staleAfterHours])).rows[0];
    await client.query('COMMIT');
    const round=v=>Math.round(Number(v));
    return {jobs:{waiting:r.jobs_waiting,leased:r.jobs_leased,expiredLeases:r.jobs_expired_leases,dead:r.jobs_dead,oldestReadySeconds:round(r.jobs_oldest_ready_seconds)},
      outbox:{pending:r.outbox_pending,failed:r.outbox_failed,oldestPendingSeconds:round(r.outbox_oldest_pending_seconds)},
      retention:{expiredSessions:r.retention_expired_sessions},
      sources:{activeReleases:f.active_releases,officialReleases:f.official_releases,staleOfficialReleases:f.stale_official,
        oldestOfficialRetrievalHours:round(f.oldest_official_hours),staleAfterHours}};
  }catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}finally{client.release();}
}
