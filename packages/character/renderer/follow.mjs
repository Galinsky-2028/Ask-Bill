/** Follow mode (AB-072 partial): where the stage lives while the reader scrolls.
 *
 * Bill stays inline in the guide panel while that slot is visible. When it scrolls away, Bill
 * walks into a compact dock *only* if the page has an empty side gutter wide enough to hold it,
 * so the dock never covers text or controls. Without such a gutter Bill simply stays inline.
 */
export const DOCK_SIZE=Object.freeze({width:150,height:176,margin:12});

export function chooseDock({slotVisible,viewportWidth,contentRight,followEnabled=true}){
  if(slotVisible||!followEnabled)return 'inline';
  const gutter=viewportWidth-contentRight;
  return gutter>=DOCK_SIZE.width+DOCK_SIZE.margin*2?'dock':'inline';
}
