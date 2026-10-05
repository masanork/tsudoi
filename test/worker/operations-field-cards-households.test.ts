import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const origin="http://localhost:8787";
async function digest(value:string){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,"0")).join("");}
async function session(name:string,role:"owner"|"admin"|"staff"|"viewer"="owner"){
  const organizationId=crypto.randomUUID(),userId=crypto.randomUUID(),token=`session_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO organizations(id,name) VALUES(?,?)").bind(organizationId,name),
    env.DB.prepare("INSERT INTO users(id,display_name) VALUES(?,?)").bind(userId,name),
    env.DB.prepare("INSERT INTO organization_members(organization_id,user_id,role) VALUES(?,?,?)").bind(organizationId,userId,role),
    env.DB.prepare("INSERT INTO organizer_sessions(id,user_id,organization_id,token_hash,expires_at) VALUES(?,?,?,?,datetime('now','+12 hours'))").bind(crypto.randomUUID(),userId,organizationId,await digest(token)),
  ]);
  return {organizationId,userId,headers:{"content-type":"application/json",cookie:`tsudoi_organizer=${token}`}};
}
async function memberSession(organizationId:string,name:string,role:"admin"|"staff"|"viewer"){
  const userId=crypto.randomUUID(),token=`session_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users(id,display_name) VALUES(?,?)").bind(userId,name),
    env.DB.prepare("INSERT INTO organization_members(organization_id,user_id,role) VALUES(?,?,?)").bind(organizationId,userId,role),
    env.DB.prepare("INSERT INTO organizer_sessions(id,user_id,organization_id,token_hash,expires_at) VALUES(?,?,?,?,datetime('now','+12 hours'))").bind(crypto.randomUUID(),userId,organizationId,await digest(token)),
  ]);
  return {userId,headers:{"content-type":"application/json",cookie:`tsudoi_organizer=${token}`}};
}
async function event(organizationId:string){const id=crypto.randomUUID();await env.DB.prepare("INSERT INTO events(id,organization_id,name,starts_at,ends_at,registration_mode,status) VALUES(?,?,?,'2026-10-01','2026-10-02','hybrid','published')").bind(id,organizationId,"Field operation event").run();return id;}
async function guest(eventId:string,organizationId:string,options:{legacy?:boolean;checkedIn?:boolean;venueId?:string|null}={}){
  const attendeeId=crypto.randomUUID(),ticketId=crypto.randomUUID(),token=`qr_${crypto.randomUUID()}`,pass=`pass_${crypto.randomUUID()}`;
  const ticketHash=await digest(options.legacy?token:pass);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO attendees(id,organization_id,event_id,venue_id,name,affiliation,registration_source,status) VALUES(?,?,?,?,?,'Unit X','admin','active')").bind(attendeeId,organizationId,eventId,options.venueId??null,`Guest ${attendeeId.slice(0,4)}`),
    env.DB.prepare("INSERT INTO tickets(id,attendee_id,event_id,token_hash,token_key_id,status) VALUES(?,?,?,?,?,?)").bind(ticketId,attendeeId,eventId,ticketHash,options.legacy?"v1":"possession-v2",options.checkedIn?"checked_in":"issued"),
    ...(options.legacy?[]:[env.DB.prepare("INSERT INTO ticket_qr_tokens(id,ticket_id,token_hash,expires_at) VALUES(?,?,?, '2999-01-01')").bind(crypto.randomUUID(),ticketId,await digest(token))]),
  ]);
  return {attendeeId,ticketId,token,pass,ticketHash,qrLink:`${origin}/public/tickets/${ticketId}/check-in/${token}`};
}
function token32(){const bytes=crypto.getRandomValues(new Uint8Array(32));let binary="";for(const b of bytes)binary+=String.fromCharCode(b);return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");}
async function createDistribution(eventId:string,headers:Record<string,string>,name:string,maxPerAttendee:number){const r=await SELF.fetch(`${origin}/api/events/${eventId}/distributions`,{method:"POST",headers,body:JSON.stringify({name,unit:"meal",maxPerAttendee})});expect(r.status).toBe(201);return (await r.json<{id:string}>()).id;}

describe("phase 3 paper cards and households",()=>{
  it("issues additional QR without revoking, then replacement revokes old QR and rotates only legacy possession",async()=>{
    const owner=await session("Card owner"),eventId=await event(owner.organizationId),member=await guest(eventId,owner.organizationId,{checkedIn:true});
    const issue=async(attendeeId:string,kind:"additional"|"replacement",requestId:string,qrToken:string,reason?:string)=>SELF.fetch(`${origin}/api/events/${eventId}/attendees/${attendeeId}/qr-cards${kind==="replacement"?"/reissue":""}`,{
      method:"POST",headers:owner.headers,body:JSON.stringify({requestId,qrToken,...(reason?{reason}:{})}),
    });
    const first=await issue(member.attendeeId,"additional",crypto.randomUUID(),token32());
    expect(first.status).toBe(201);const firstJson=await first.json<any>();
    expect(firstJson.card).toMatchObject({kind:"additional",active:true});expect(firstJson.card.qrPngDataUrl).toMatch(/^data:image\/png;base64,iVBOR/);
    expect(await env.DB.prepare("SELECT status FROM tickets WHERE id=?").bind(member.ticketId).first()).toMatchObject({status:"checked_in"});
    const priorCount=await env.DB.prepare("SELECT COUNT(*) AS count FROM ticket_qr_tokens WHERE ticket_id=? AND expires_at>CURRENT_TIMESTAMP").bind(member.ticketId).first<{count:number}>();
    expect(priorCount?.count).toBe(2);
    const v2Replacement=await issue(member.attendeeId,"replacement",crypto.randomUUID(),token32(),"紛失");expect(v2Replacement.status).toBe(201);
    expect(await env.DB.prepare("SELECT token_hash,token_key_id,status FROM tickets WHERE id=?").bind(member.ticketId).first()).toMatchObject({token_hash:member.ticketHash,token_key_id:"possession-v2",status:"checked_in"});
    const stillPossession=await SELF.fetch(`${origin}/public/tickets/${member.ticketId}/passkeys/options`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ticketToken:member.pass})});expect(stillPossession.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM ticket_qr_tokens WHERE ticket_id=? AND expires_at>CURRENT_TIMESTAMP").bind(member.ticketId).first<{count:number}>().then(r=>r?.count)).toBe(1);
    const tokenV1=await guest(eventId,owner.organizationId,{legacy:true});
    const legacyIssue=await issue(tokenV1.attendeeId,"additional",crypto.randomUUID(),token32());expect(legacyIssue.status).toBe(201);
    const replacementRequest=crypto.randomUUID();
    const legacyReplacement=await issue(tokenV1.attendeeId,"replacement",replacementRequest,token32(),"カードを紛失");
    expect(legacyReplacement.status).toBe(201);const replacementJson=await legacyReplacement.json<any>();
    expect(replacementJson).toMatchObject({legacyCredentialInvalidated:true,revokedCount:1,card:{kind:"replacement",active:true}});
    const rotated=await env.DB.prepare("SELECT token_hash,token_key_id,status FROM tickets WHERE id=?").bind(tokenV1.ticketId).first<{token_hash:string;token_key_id:string;status:string}>();
    expect(rotated).toMatchObject({token_key_id:"possession-v2",status:"issued"});expect(rotated?.token_hash).not.toBe(tokenV1.ticketHash);
    const oldPossessionOptions=await SELF.fetch(`${origin}/public/tickets/${tokenV1.ticketId}/passkeys/options`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ticketToken:tokenV1.token})});expect(oldPossessionOptions.status).toBe(404);
    const oldQrResolve=await SELF.fetch(`${origin}/api/events/${eventId}/credentials/resolve`,{method:"POST",headers:owner.headers,body:JSON.stringify({qrLink:tokenV1.qrLink})});expect(oldQrResolve.status).toBe(404);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM ticket_qr_tokens WHERE ticket_id=? AND expires_at>CURRENT_TIMESTAMP").bind(tokenV1.ticketId).first<{count:number}>().then(r=>r?.count)).toBe(1);
    const status=await SELF.fetch(`${origin}/api/events/${eventId}/attendees/${tokenV1.attendeeId}/qr-cards/by-request/${replacementRequest}`,{headers:owner.headers});
    await expect(status.json()).resolves.toMatchObject({card:{id:replacementJson.card.id,kind:"replacement",active:true}});
  }, 15_000);

  it("creates scoped household memberships and commits concurrent proxy claims only once at the per-round cap",async()=>{
    const owner=await session("Proxy owner"),eventId=await event(owner.organizationId),
      collector=await guest(eventId,owner.organizationId),beneficiary=await guest(eventId,owner.organizationId);
    const householdResponse=await SELF.fetch(`${origin}/api/events/${eventId}/households`,{method:"POST",headers:owner.headers,body:JSON.stringify({name:"Same name is allowed"})});
    expect(householdResponse.status).toBe(201);const household=(await householdResponse.json<any>()).household;
    for(const member of [collector,beneficiary]){
      const added=await SELF.fetch(`${origin}/api/events/${eventId}/households/${household.id}/members`,{method:"POST",headers:owner.headers,body:JSON.stringify({attendeeId:member.attendeeId})});
      expect(added.status).toBe(201);
    }
    const detail=await SELF.fetch(`${origin}/api/events/${eventId}/households/${household.id}`,{headers:owner.headers});
    await expect(detail.json()).resolves.toMatchObject({household:{name:"Same name is allowed",members:expect.arrayContaining([expect.objectContaining({ticketStatus:"issued",used:null,remaining:null})])}});
    const distributionId=await createDistribution(eventId,owner.headers,"Lunch",1);
    const proxy=(requestId:string)=>SELF.fetch(`${origin}/api/events/${eventId}/distributions/${distributionId}/proxy-claims`,{method:"POST",headers:owner.headers,
      body:JSON.stringify({requestId,householdId:household.id,collectorId:collector.attendeeId,items:[{attendeeId:beneficiary.attendeeId,quantity:1}]})});
    const requestA=crypto.randomUUID(),requestB=crypto.randomUUID();
    const results=await Promise.all([proxy(requestA),proxy(requestB)]);
    const bodies=await Promise.all(results.map(r=>r.json<any>()));
    expect(results.map(r=>r.status).sort()).toEqual([201,201]);
    expect(bodies.map(b=>b.outcome).sort()).toEqual(["accepted","limit_reached"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM distribution_claims WHERE distribution_id=? AND attendee_id=? AND proxy_group_id IS NOT NULL AND outcome='accepted'").bind(distributionId,beneficiary.attendeeId).first<{count:number}>().then(r=>r?.count)).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action LIKE 'distribution.proxy_%' AND target_type='distribution_proxy_claim'").first<{count:number}>().then(r=>r?.count)).toBe(2);
  }, 15_000);

  it("keeps a mixed-cap proxy batch all-or-none and reverses its accepted child claims only as a group",async()=>{
    const owner=await session("Atomic proxy owner"),eventId=await event(owner.organizationId),collector=await guest(eventId,owner.organizationId),a=await guest(eventId,owner.organizationId),b=await guest(eventId,owner.organizationId);
    const household=(await (await SELF.fetch(`${origin}/api/events/${eventId}/households`,{method:"POST",headers:owner.headers,body:JSON.stringify({name:"Household"})})).json<any>()).household;
    for(const g of [collector,a,b])await SELF.fetch(`${origin}/api/events/${eventId}/households/${household.id}/members`,{method:"POST",headers:owner.headers,body:JSON.stringify({attendeeId:g.attendeeId})});
    const lunch=await createDistribution(eventId,owner.headers,"Lunch",1);
    const individual=await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${lunch}/claims`,{method:"POST",headers:owner.headers,body:JSON.stringify({requestId:crypto.randomUUID(),qrLink:a.qrLink,quantity:1})});
    expect(individual.status).toBe(201);
    const mixedId=crypto.randomUUID();
    const mixed=await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${lunch}/proxy-claims`,{method:"POST",headers:owner.headers,body:JSON.stringify({requestId:mixedId,householdId:household.id,collectorId:collector.attendeeId,items:[{attendeeId:a.attendeeId,quantity:1},{attendeeId:b.attendeeId,quantity:1}]})});
    expect(mixed.status).toBe(201);const mixedBody=await mixed.json<any>();expect(mixedBody.outcome).toBe("limit_reached");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM distribution_claims WHERE distribution_id=? AND proxy_group_id=?").bind(lunch,mixedBody.proxyClaim.id).first<{count:number}>().then(r=>r?.count)).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM distribution_claims WHERE distribution_id=? AND attendee_id=? AND outcome='accepted' AND reversed_at IS NULL").bind(lunch,b.attendeeId).first<{count:number}>().then(r=>r?.count)).toBe(0);

    const dinner=await createDistribution(eventId,owner.headers,"Dinner",2),acceptedId=crypto.randomUUID();
    const accepted=await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${dinner}/proxy-claims`,{method:"POST",headers:owner.headers,body:JSON.stringify({requestId:acceptedId,householdId:household.id,collectorId:collector.attendeeId,items:[{attendeeId:a.attendeeId,quantity:1},{attendeeId:b.attendeeId,quantity:1}]})});
    expect(accepted.status).toBe(201);const acceptedBody=await accepted.json<any>();expect(acceptedBody.outcome).toBe("accepted");
    expect(acceptedBody.proxyClaim.items).toHaveLength(2);
    const firstChild=acceptedBody.proxyClaim.items[0].claimId;
    const childReverse=await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${dinner}/claims/${firstChild}/reverse`,{method:"POST",headers:owner.headers,body:JSON.stringify({reason:"partial"})});
    expect(childReverse.status).toBe(409);await expect(childReverse.json()).resolves.toMatchObject({error:"proxy_claim_requires_group_reverse"});
    const reverse=await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${dinner}/proxy-claims/${acceptedBody.proxyClaim.id}/reverse`,{method:"POST",headers:owner.headers,body:JSON.stringify({reason:"取り消し"})});
    expect(reverse.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM distribution_claims WHERE proxy_group_id=? AND reversed_at IS NOT NULL").bind(acceptedBody.proxyClaim.id).first<{count:number}>().then(r=>r?.count)).toBe(2);
    const repeat=await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${dinner}/proxy-claims/${acceptedBody.proxyClaim.id}/reverse`,{method:"POST",headers:owner.headers,body:JSON.stringify({reason:"再送"})});expect(repeat.status).toBe(409);
  });

  it("rolls back proxy claims and card issuance when the audit insert fails, and rejects viewers/cross-tenant access",async()=>{
    const owner=await session("Rollback owner"),other=await session("Other tenant"),viewer=await session("Read-only", "viewer"),eventId=await event(owner.organizationId),collector=await guest(eventId,owner.organizationId),beneficiary=await guest(eventId,owner.organizationId);
    const household=(await (await SELF.fetch(`${origin}/api/events/${eventId}/households`,{method:"POST",headers:owner.headers,body:JSON.stringify({name:"Private family"})})).json<any>()).household;
    for(const g of [collector,beneficiary])await SELF.fetch(`${origin}/api/events/${eventId}/households/${household.id}/members`,{method:"POST",headers:owner.headers,body:JSON.stringify({attendeeId:g.attendeeId})});
    const distribution=await createDistribution(eventId,owner.headers,"Meal",2);
    await env.DB.prepare(`CREATE TRIGGER fail_proxy_audit BEFORE INSERT ON audit_logs WHEN NEW.action='distribution.proxy_claimed' BEGIN SELECT RAISE(ABORT,'proxy_audit_failed'); END`).run();
    try{
      const failed=await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${distribution}/proxy-claims`,{method:"POST",headers:owner.headers,body:JSON.stringify({requestId:crypto.randomUUID(),householdId:household.id,collectorId:collector.attendeeId,items:[{attendeeId:beneficiary.attendeeId,quantity:1}]})});
      expect(failed.status).toBe(500);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM distribution_proxy_claims WHERE distribution_id=?").bind(distribution).first<{count:number}>().then(r=>r?.count)).toBe(0);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM distribution_claims WHERE distribution_id=?").bind(distribution).first<{count:number}>().then(r=>r?.count)).toBe(0);
    }finally{await env.DB.prepare("DROP TRIGGER IF EXISTS fail_proxy_audit").run();}
    await env.DB.prepare(`CREATE TRIGGER fail_card_audit BEFORE INSERT ON audit_logs WHEN NEW.action='ticket.qr_card_issued' BEGIN SELECT RAISE(ABORT,'card_audit_failed'); END`).run();
    try{
      const before=await env.DB.prepare("SELECT COUNT(*) AS count FROM ticket_qr_tokens WHERE ticket_id=?").bind(beneficiary.ticketId).first<{count:number}>();
      const failed=await SELF.fetch(`${origin}/api/events/${eventId}/attendees/${beneficiary.attendeeId}/qr-cards`,{method:"POST",headers:owner.headers,body:JSON.stringify({requestId:crypto.randomUUID(),qrToken:token32()})});
      expect(failed.status).toBe(500);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM ticket_qr_tokens WHERE ticket_id=?").bind(beneficiary.ticketId).first<{count:number}>().then(r=>r?.count)).toBe(before?.count);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM ticket_qr_cards WHERE ticket_id=?").bind(beneficiary.ticketId).first<{count:number}>().then(r=>r?.count)).toBe(0);
    }finally{await env.DB.prepare("DROP TRIGGER IF EXISTS fail_card_audit").run();}
    const viewerWrite=await SELF.fetch(`${origin}/api/events/${eventId}/households`,{method:"POST",headers:viewer.headers,body:JSON.stringify({name:"no"})});expect(viewerWrite.status).toBe(403);
    const otherRead=await SELF.fetch(`${origin}/api/events/${eventId}/households/${household.id}`,{headers:other.headers});expect(otherRead.status).toBe(404);
  });

  it("rechecks staff venue authorization for card reconciliation and proxy retries",async()=>{
    const owner=await session("Staff scope owner"),staff=await memberSession(owner.organizationId,"Venue staff","staff"),eventId=await event(owner.organizationId),venueA=crypto.randomUUID(),venueB=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO venues(id,event_id,name) VALUES(?,?,?)").bind(venueA,eventId,"A"),
      env.DB.prepare("INSERT INTO venues(id,event_id,name) VALUES(?,?,?)").bind(venueB,eventId,"B"),
      env.DB.prepare("INSERT INTO venue_staff_assignments(venue_id,user_id) VALUES(?,?)").bind(venueA,staff.userId),
    ]);
    const collector=await guest(eventId,owner.organizationId,{venueId:venueA}),beneficiary=await guest(eventId,owner.organizationId,{venueId:venueA});
    const cardRequestId=crypto.randomUUID(),cardToken=token32();
    const cardIssue=await SELF.fetch(`${origin}/api/events/${eventId}/attendees/${beneficiary.attendeeId}/qr-cards`,{method:"POST",headers:staff.headers,body:JSON.stringify({requestId:cardRequestId,qrToken:cardToken,venueId:venueA})});expect(cardIssue.status).toBe(201);
    const household=(await (await SELF.fetch(`${origin}/api/events/${eventId}/households`,{method:"POST",headers:owner.headers,body:JSON.stringify({name:"Staff family"})})).json<any>()).household;
    for(const g of [collector,beneficiary])await SELF.fetch(`${origin}/api/events/${eventId}/households/${household.id}/members`,{method:"POST",headers:owner.headers,body:JSON.stringify({attendeeId:g.attendeeId})});
    const distribution=await createDistribution(eventId,owner.headers,"Staff lunch",1),proxyRequestId=crypto.randomUUID();
    const proxyBody={requestId:proxyRequestId,householdId:household.id,collectorId:collector.attendeeId,items:[{attendeeId:beneficiary.attendeeId,quantity:1}],venueId:venueA};
    const proxy=await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${distribution}/proxy-claims`,{method:"POST",headers:staff.headers,body:JSON.stringify(proxyBody)});expect(proxy.status).toBe(201);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM venue_staff_assignments WHERE venue_id=? AND user_id=?").bind(venueA,staff.userId),
      env.DB.prepare("INSERT INTO venue_staff_assignments(venue_id,user_id) VALUES(?,?)").bind(venueB,staff.userId),
    ]);
    const cardStatus=await SELF.fetch(`${origin}/api/events/${eventId}/attendees/${beneficiary.attendeeId}/qr-cards/by-request/${cardRequestId}`,{headers:staff.headers});expect(cardStatus.status).toBe(404);
    const cardRetry=await SELF.fetch(`${origin}/api/events/${eventId}/attendees/${beneficiary.attendeeId}/qr-cards`,{method:"POST",headers:staff.headers,body:JSON.stringify({requestId:cardRequestId,qrToken:cardToken,venueId:venueA})});expect(cardRetry.status).toBe(403);
    const proxyStatus=await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${distribution}/proxy-claims/by-request/${proxyRequestId}`,{headers:staff.headers});expect(proxyStatus.status).toBe(403);
    const proxyRetry=await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${distribution}/proxy-claims`,{method:"POST",headers:staff.headers,body:JSON.stringify(proxyBody)});expect(proxyRetry.status).toBe(403);
  });

  it("binds card and proxy request IDs to the issuing actor and exact payload",async()=>{
    const owner=await session("Idempotency owner"),admin=await memberSession(owner.organizationId,"Second admin","admin"),eventId=await event(owner.organizationId),collector=await guest(eventId,owner.organizationId),beneficiary=await guest(eventId,owner.organizationId);
    const cardRequestId=crypto.randomUUID(),qrToken=token32(),cardPath=`${origin}/api/events/${eventId}/attendees/${beneficiary.attendeeId}/qr-cards`;
    const cardBody={requestId:cardRequestId,qrToken};
    const first=await SELF.fetch(cardPath,{method:"POST",headers:owner.headers,body:JSON.stringify(cardBody)});expect(first.status).toBe(201);const firstCard=(await first.json<any>()).card;
    const replay=await SELF.fetch(cardPath,{method:"POST",headers:owner.headers,body:JSON.stringify(cardBody)});expect(replay.status).toBe(200);await expect(replay.json()).resolves.toMatchObject({card:{id:firstCard.id,active:true}});
    const changedCard=await SELF.fetch(cardPath,{method:"POST",headers:owner.headers,body:JSON.stringify({...cardBody,qrToken:token32()})});expect(changedCard.status).toBe(409);
    const otherActorCard=await SELF.fetch(cardPath,{method:"POST",headers:admin.headers,body:JSON.stringify(cardBody)});expect(otherActorCard.status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM ticket_qr_cards WHERE ticket_id=?").bind(beneficiary.ticketId).first<{count:number}>().then(r=>r?.count)).toBe(1);

    const household=(await (await SELF.fetch(`${origin}/api/events/${eventId}/households`,{method:"POST",headers:owner.headers,body:JSON.stringify({name:"Bound family"})})).json<any>()).household;
    for(const g of [collector,beneficiary])await SELF.fetch(`${origin}/api/events/${eventId}/households/${household.id}/members`,{method:"POST",headers:owner.headers,body:JSON.stringify({attendeeId:g.attendeeId})});
    const distribution=await createDistribution(eventId,owner.headers,"Bound meal",2),requestId=crypto.randomUUID(),proxyPath=`${origin}/api/events/${eventId}/distributions/${distribution}/proxy-claims`;
    const proxyBody={requestId,householdId:household.id,collectorId:collector.attendeeId,items:[{attendeeId:beneficiary.attendeeId,quantity:1}]};
    const proxy=await SELF.fetch(proxyPath,{method:"POST",headers:owner.headers,body:JSON.stringify(proxyBody)});expect(proxy.status).toBe(201);const proxyResult=await proxy.json<any>();
    const proxyReplay=await SELF.fetch(proxyPath,{method:"POST",headers:owner.headers,body:JSON.stringify(proxyBody)});expect(proxyReplay.status).toBe(200);await expect(proxyReplay.json()).resolves.toMatchObject({proxyClaim:{id:proxyResult.proxyClaim.id}});
    const proxyChanged=await SELF.fetch(proxyPath,{method:"POST",headers:owner.headers,body:JSON.stringify({...proxyBody,items:[{attendeeId:beneficiary.attendeeId,quantity:2}]})});expect(proxyChanged.status).toBe(409);
    const proxyOtherActor=await SELF.fetch(proxyPath,{method:"POST",headers:admin.headers,body:JSON.stringify(proxyBody)});expect(proxyOtherActor.status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM distribution_proxy_claims WHERE distribution_id=? AND request_id=?").bind(distribution,requestId).first<{count:number}>().then(r=>r?.count)).toBe(1);
  });
});
