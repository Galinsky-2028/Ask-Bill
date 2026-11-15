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

export async function collectDiagnostics(pool,publisherId){
  const client=await pool.connect();
  try{
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('ask_bill.publisher_id',$1,true)",[publisherId]);
    const r=(await client.query(SQL)).rows[0];
    await client.query('COMMIT');
    const round=v=>Math.round(Number(v));
    return {jobs:{waiting:r.jobs_waiting,leased:r.jobs_leased,expiredLeases:r.jobs_expired_leases,dead:r.jobs_dead,oldestReadySeconds:round(r.jobs_oldest_ready_seconds)},
      outbox:{pending:r.outbox_pending,failed:r.outbox_failed,oldestPendingSeconds:round(r.outbox_oldest_pending_seconds)},
      retention:{expiredSessions:r.retention_expired_sessions}};
  }catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}finally{client.release();}
}
