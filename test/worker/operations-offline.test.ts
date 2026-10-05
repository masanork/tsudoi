import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const origin = "http://localhost:8787";
async function digest(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function session(name: string, role: "owner"|"staff"|"viewer" = "owner", existingOrganizationId?:string) {
  const organizationId=existingOrganizationId??crypto.randomUUID(),userId=crypto.randomUUID(),token=`session_${crypto.randomUUID()}`;
  await env.DB.batch([
    ...(existingOrganizationId?[]:[env.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(organizationId,name)]),
    env.DB.prepare("INSERT INTO users(id,display_name) VALUES (?,?)").bind(userId,name),
    env.DB.prepare("INSERT INTO organization_members(organization_id,user_id,role) VALUES (?,?,?)").bind(organizationId,userId,role),
    env.DB.prepare("INSERT INTO organizer_sessions(id,user_id,organization_id,token_hash,expires_at) VALUES (?,?,?,?,datetime('now','+12 hours'))").bind(crypto.randomUUID(),userId,organizationId,await digest(token)),
  ]);
  return {organizationId,userId,headers:{cookie:`tsudoi_organizer=${token}`,"content-type":"application/json"}};
}
async function event(org:string) {
  const id=crypto.randomUUID();
  await env.DB.prepare("INSERT INTO events(id,organization_id,name,starts_at,ends_at,registration_mode,status) VALUES (?,?,?,'2026-10-01','2026-10-02','hybrid','published')").bind(id,org,"Offline event").run();
  return id;
}
async function venue(eventId:string,name:string) {
  const id=crypto.randomUUID();await env.DB.prepare("INSERT INTO venues(id,event_id,name) VALUES (?,?,?)").bind(id,eventId,name).run();return id;
}
async function guest(eventId:string,org:string,venueId:string|null,name="Offline guest") {
  const attendeeId=crypto.randomUUID(),ticketId=crypto.randomUUID(),token=`qr_${crypto.randomUUID()}`;
  const possession=`passkey_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO attendees(id,organization_id,event_id,venue_id,name,affiliation,registration_source,status,email_normalized) VALUES (?,?,?,?,?,'PRIVATE','admin','active',?)").bind(attendeeId,org,eventId,venueId,name,`${attendeeId}@example.test`),
    env.DB.prepare("INSERT INTO tickets(id,attendee_id,event_id,token_hash,token_key_id,status) VALUES (?,?,?,?, 'possession-v2','issued')").bind(ticketId,attendeeId,eventId,await digest(possession)),
    env.DB.prepare("INSERT INTO ticket_qr_tokens(id,ticket_id,token_hash,expires_at) VALUES (?,?,?,datetime('now','+2 hours'))").bind(crypto.randomUUID(),ticketId,await digest(token)),
  ]);
  return {attendeeId,ticketId,token,possession,qrLink:`${origin}/public/tickets/${ticketId}/check-in/${token}`};
}
async function distribution(eventId:string,headers:Record<string,string>) {
  const response=await SELF.fetch(`${origin}/api/events/${eventId}/distributions`,{method:"POST",headers,body:JSON.stringify({name:"Meal",unit:"meal",maxPerAttendee:2})});
  expect(response.status).toBe(201);return (await response.json<{id:string}>()).id;
}

describe("phase 4 offline snapshot proofs",()=>{
  it("returns bounded minimal session snapshot and accepts credentialHash as the same live QR proof",async()=>{
    const owner=await session("Offline owner");const eventId=await event(owner.organizationId);const venueId=await venue(eventId,"Hall");
    const attendee=await guest(eventId,owner.organizationId,venueId);const unassigned=await guest(eventId,owner.organizationId,null,"Unassigned guest");
    const distributionId=await distribution(eventId,owner.headers);
    const response=await SELF.fetch(`${origin}/api/events/${eventId}/offline-snapshot?venueId=${venueId}`,{headers:owner.headers});
    expect(response.status).toBe(200);
    const body=await response.json<{snapshot:{actorId:string;preparedAt:string;expiresAt:string;attendees:{id:string;credentials:{credentialHash:string;expiresAt:string;kind:string}[];ticket:{id:string}}[];distributions:{id:string}[]}}>();
    expect(body.snapshot.actorId).toBe(owner.userId);expect(body.snapshot.distributions).toEqual([expect.objectContaining({id:distributionId})]);
    expect(Date.parse(body.snapshot.expiresAt)-Date.parse(body.snapshot.preparedAt)).toBe(12*60*60*1000);
    expect(body.snapshot.attendees.map(a=>a.id)).toContain(attendee.attendeeId);
    expect(body.snapshot.attendees.map(a=>a.id)).toContain(unassigned.attendeeId);
    const row=body.snapshot.attendees.find(a=>a.id===attendee.attendeeId)!;
    const hash=await digest(attendee.token);
    expect(row.credentials).toEqual([expect.objectContaining({credentialHash:hash,kind:"qr"})]);
    const storedExpiry=await env.DB.prepare("SELECT expires_at FROM ticket_qr_tokens WHERE ticket_id=?").bind(attendee.ticketId).first<{expires_at:string}>();
    expect(row.credentials[0]!.expiresAt).toMatch(/Z$/);
    expect(Math.abs(Date.parse(row.credentials[0]!.expiresAt)-Date.parse(`${storedExpiry!.expires_at.replace(" ","T")}Z`))).toBeLessThan(1000);
    const serialized=JSON.stringify(body);
    expect(serialized).not.toContain(attendee.token);expect(serialized).not.toContain(attendee.possession);expect(serialized).not.toContain("PRIVATE");expect(serialized).not.toContain("@example.test");
    const requestId=crypto.randomUUID();
    const first=await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${distributionId}/claims`,{method:"POST",headers:owner.headers,body:JSON.stringify({requestId,attendeeId:attendee.attendeeId,credentialHash:hash,quantity:1,venueId})});
    expect(first.status).toBe(201);const firstBody=await first.json<{claim:{id:string};outcome:string}>();expect(firstBody.outcome).toBe("accepted");
    const legacyPayloadHash=await digest(JSON.stringify({actorId:owner.userId,attendeeId:attendee.attendeeId,ticketId:attendee.ticketId,quantity:1,venueId}));
    await env.DB.prepare("UPDATE distribution_claims SET payload_hash=? WHERE id=?").bind(legacyPayloadHash,firstBody.claim.id).run();
    const replay=await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${distributionId}/claims`,{method:"POST",headers:owner.headers,body:JSON.stringify({requestId,qrLink:attendee.qrLink,quantity:1,venueId})});
    expect(replay.status).toBe(200);await expect(replay.json()).resolves.toMatchObject({claim:{id:firstBody.claim.id},outcome:"accepted"});
    const secondRequest=crypto.randomUUID();
    expect((await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${distributionId}/claims`,{method:"POST",headers:owner.headers,body:JSON.stringify({requestId:secondRequest,qrLink:attendee.qrLink,quantity:1,venueId})})).status).toBe(201);
    const alternateToken=`qr_${crypto.randomUUID()}`,alternateHash=await digest(alternateToken);
    await env.DB.prepare("INSERT INTO ticket_qr_tokens(id,ticket_id,token_hash,expires_at) VALUES (?,?,?,datetime('now','+2 hours'))").bind(crypto.randomUUID(),attendee.ticketId,alternateHash).run();
    const proofMismatch=await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${distributionId}/claims`,{method:"POST",headers:owner.headers,body:JSON.stringify({requestId:secondRequest,attendeeId:attendee.attendeeId,credentialHash:alternateHash,quantity:1,venueId})});
    expect(proofMismatch.status).toBe(409);
    await env.DB.prepare("UPDATE ticket_qr_tokens SET expires_at='2000-01-01 00:00:00' WHERE ticket_id=?").bind(attendee.ticketId).run();
    const denied=await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${distributionId}/claims`,{method:"POST",headers:owner.headers,body:JSON.stringify({requestId:crypto.randomUUID(),attendeeId:attendee.attendeeId,credentialHash:hash,quantity:1,venueId})});
    expect(denied.status).toBe(404);
    const saved=await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${distributionId}/claims/by-request/${requestId}`,{headers:owner.headers});
    expect(saved.status).toBe(200);await expect(saved.json()).resolves.toMatchObject({claim:{id:firstBody.claim.id,outcome:"accepted"}});
    const refreshed=await SELF.fetch(`${origin}/api/events/${eventId}/offline-snapshot?venueId=${venueId}`,{headers:owner.headers});
    const refreshedRow=(await refreshed.json<{snapshot:{attendees:{id:string;credentials:{credentialHash:string}[]}[]}} >()).snapshot.attendees.find(a=>a.id===attendee.attendeeId)!;
    expect(refreshedRow.credentials.map(item=>item.credentialHash)).not.toContain(hash);
  });

  it("requires an organizer session, current staff venue scope, and gives current IN venue precedence",async()=>{
    const owner=await session("Snapshot scope owner");const eventId=await event(owner.organizationId);const venueA=await venue(eventId,"A"),venueB=await venue(eventId,"B");
    const staffA=await session("Snapshot staff A","staff",owner.organizationId),staffB=await session("Snapshot staff B","staff",owner.organizationId);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO venue_staff_assignments(venue_id,user_id) VALUES (?,?)").bind(venueA,staffA.userId),
      env.DB.prepare("INSERT INTO venue_staff_assignments(venue_id,user_id) VALUES (?,?)").bind(venueB,staffB.userId),
    ]);
    const attendee=await guest(eventId,owner.organizationId,venueA);
    await env.DB.prepare("INSERT INTO attendee_presence(id,organization_id,event_id,attendee_id,state,venue_id,revision) VALUES (?,?,?,?,'in',?,1)").bind(crypto.randomUUID(),owner.organizationId,eventId,attendee.attendeeId,venueB).run();
    const current=await SELF.fetch(`${origin}/api/events/${eventId}/offline-snapshot?venueId=${venueB}`,{headers:staffB.headers});
    expect(current.status).toBe(200);await expect(current.json()).resolves.toMatchObject({snapshot:{attendees:[expect.objectContaining({id:attendee.attendeeId,registrationVenueId:venueA,presence:{state:"in",venueId:venueB,revision:1}})]}});
    const wrongVenue=await SELF.fetch(`${origin}/api/events/${eventId}/offline-snapshot?venueId=${venueA}`,{headers:staffA.headers});
    expect(wrongVenue.status).toBe(200);expect((await wrongVenue.json<{snapshot:{attendees:{id:string}[]}} >()).snapshot.attendees.some(a=>a.id===attendee.attendeeId)).toBe(false);
    expect((await SELF.fetch(`${origin}/api/events/${eventId}/offline-snapshot?venueId=${venueB}`,{headers:staffA.headers})).status).toBe(403);
    const viewer=await session("Snapshot viewer","viewer",owner.organizationId);
    const noScope=await SELF.fetch(`${origin}/api/events/${eventId}/offline-snapshot?venueId=${venueA}`,{headers:viewer.headers});expect(noScope.status).toBe(403);
    const apiToken=`tsu_${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO api_tokens(id,organization_id,label,token_hash,scopes) VALUES (?,?,?,?,'[\"checkin:write\"]')").bind(crypto.randomUUID(),owner.organizationId,"API",await digest(apiToken)).run();
    const apiResponse=await SELF.fetch(`${origin}/api/events/${eventId}/offline-snapshot?venueId=${venueA}`,{headers:{authorization:`Bearer ${apiToken}`}});
    expect(apiResponse.status).toBe(403);
    const otherOrg=await session("Snapshot other tenant");
    const crossTenant=await SELF.fetch(`${origin}/api/events/${eventId}/offline-snapshot?venueId=${venueA}`,{headers:otherOrg.headers});expect(crossTenant.status).toBe(404);
    const ownerToken=owner.headers.cookie!.slice("tsudoi_organizer=".length);
    await env.DB.prepare("UPDATE organizer_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE token_hash=?").bind(await digest(ownerToken)).run();
    const revoked=await SELF.fetch(`${origin}/api/events/${eventId}/offline-snapshot?venueId=${venueA}`,{headers:owner.headers});expect(revoked.status).toBe(401);
  });

  it("uses current IN venue for distribution scope, then registration venue after exit",async()=>{
    const owner=await session("Distribution venue owner");const eventId=await event(owner.organizationId);const venueA=await venue(eventId,"Registration A"),venueB=await venue(eventId,"Current B");
    const staffA=await session("Distribution staff A","staff",owner.organizationId),staffB=await session("Distribution staff B","staff",owner.organizationId);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO venue_staff_assignments(venue_id,user_id) VALUES (?,?)").bind(venueA,staffA.userId),
      env.DB.prepare("INSERT INTO venue_staff_assignments(venue_id,user_id) VALUES (?,?)").bind(venueB,staffB.userId),
    ]);
    const attendee=await guest(eventId,owner.organizationId,venueA);const distributionId=await distribution(eventId,owner.headers);
    await env.DB.prepare("INSERT INTO attendee_presence(id,organization_id,event_id,attendee_id,state,venue_id,revision) VALUES (?,?,?,?,'in',?,1)").bind(crypto.randomUUID(),owner.organizationId,eventId,attendee.attendeeId,venueB).run();
    const hash=await digest(attendee.token),requestId=crypto.randomUUID();
    const allowed=await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${distributionId}/claims`,{method:"POST",headers:staffB.headers,body:JSON.stringify({requestId,attendeeId:attendee.attendeeId,credentialHash:hash,quantity:1,venueId:venueB})});
    expect(allowed.status).toBe(201);await expect(allowed.json()).resolves.toMatchObject({outcome:"accepted"});
    const wrongAssignment=await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${distributionId}/claims`,{method:"POST",headers:staffA.headers,body:JSON.stringify({requestId:crypto.randomUUID(),qrLink:attendee.qrLink,quantity:1,venueId:venueA})});
    expect(wrongAssignment.status).toBe(403);
    await env.DB.prepare("UPDATE attendee_presence SET state='out',venue_id=NULL,revision=2 WHERE event_id=? AND attendee_id=?").bind(eventId,attendee.attendeeId).run();
    const returned=await SELF.fetch(`${origin}/api/events/${eventId}/distributions/${distributionId}/claims`,{method:"POST",headers:staffA.headers,body:JSON.stringify({requestId:crypto.randomUUID(),qrLink:attendee.qrLink,quantity:1,venueId:venueA})});
    expect(returned.status).toBe(201);await expect(returned.json()).resolves.toMatchObject({outcome:"accepted",used:2,remaining:0});
  });

  it("accepts a credentialHash for presence and treats it as the same idempotent proof as its QR link",async()=>{
    const owner=await session("Offline movement owner");const eventId=await event(owner.organizationId);const venueId=await venue(eventId,"Movement hall");const attendee=await guest(eventId,owner.organizationId,venueId);
    const requestId=crypto.randomUUID(),hash=await digest(attendee.token);
    const write=(target:Record<string,string>)=>SELF.fetch(`${origin}/api/events/${eventId}/presence/movements`,{method:"POST",headers:owner.headers,body:JSON.stringify({requestId,action:"enter",venueId,expectedRevision:0,...target})});
    const first=await write({qrLink:attendee.qrLink});expect(first.status).toBe(201);const firstBody=await first.json<{movement:{id:string};outcome:string}>();expect(firstBody.outcome).toBe("accepted");
    const replay=await write({attendeeId:attendee.attendeeId,credentialHash:hash});expect(replay.status).toBe(200);await expect(replay.json()).resolves.toMatchObject({movement:{id:firstBody.movement.id},outcome:"accepted"});
    const invalidHash=await SELF.fetch(`${origin}/api/events/${eventId}/presence/movements`,{method:"POST",headers:owner.headers,body:JSON.stringify({requestId:crypto.randomUUID(),attendeeId:attendee.attendeeId,credentialHash:await digest(attendee.possession),action:"exit",venueId,expectedRevision:1})});
    expect(invalidHash.status).toBe(404);
  });

  it("fails closed at the attendee, active distribution, and per-person credential bounds",async()=>{
    const owner=await session("Snapshot bounds owner");
    const peopleEvent=await event(owner.organizationId),peopleVenue=await venue(peopleEvent,"People cap"),peoplePrefix=crypto.randomUUID();
    await env.DB.prepare(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<1001)
      INSERT INTO attendees(id,organization_id,event_id,venue_id,name,registration_source,status)
      SELECT ?||'-a'||n,?,?,?,'Bound guest '||n,'admin','active' FROM seq`).bind(peoplePrefix,owner.organizationId,peopleEvent,peopleVenue).run();
    await env.DB.prepare(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<1001)
      INSERT INTO tickets(id,attendee_id,event_id,token_hash,token_key_id,status)
      SELECT ?||'-t'||n,?||'-a'||n,?,?||'-h'||n,'possession-v2','issued' FROM seq`).bind(peoplePrefix,peoplePrefix,peopleEvent,peoplePrefix).run();
    const peopleLimit=await SELF.fetch(`${origin}/api/events/${peopleEvent}/offline-snapshot?venueId=${peopleVenue}`,{headers:owner.headers});
    expect(peopleLimit.status).toBe(413);await expect(peopleLimit.json()).resolves.toMatchObject({error:"offline_snapshot_attendee_limit",limit:1000});

    const roundEvent=await event(owner.organizationId),roundVenue=await venue(roundEvent,"Round cap"),roundPrefix=crypto.randomUUID();
    await env.DB.prepare(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<101)
      INSERT INTO distributions(id,organization_id,event_id,name,unit,max_per_attendee,active,created_by)
      SELECT ?||'-d'||n,?,?,'Round '||n,'meal',1,1,? FROM seq`).bind(roundPrefix,owner.organizationId,roundEvent,owner.userId).run();
    const roundLimit=await SELF.fetch(`${origin}/api/events/${roundEvent}/offline-snapshot?venueId=${roundVenue}`,{headers:owner.headers});
    expect(roundLimit.status).toBe(413);await expect(roundLimit.json()).resolves.toMatchObject({error:"offline_snapshot_distribution_limit",limit:100});

    const credentialEvent=await event(owner.organizationId),credentialVenue=await venue(credentialEvent,"Credential cap"),target=await guest(credentialEvent,owner.organizationId,credentialVenue),tokenPrefix=crypto.randomUUID();
    await env.DB.prepare(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<32)
      INSERT INTO ticket_qr_tokens(id,ticket_id,token_hash,expires_at)
      SELECT ?||'-q'||n,?,?||'-hash-'||n,datetime('now','+2 hours') FROM seq`).bind(tokenPrefix,target.ticketId,tokenPrefix).run();
    const credentialLimit=await SELF.fetch(`${origin}/api/events/${credentialEvent}/offline-snapshot?venueId=${credentialVenue}`,{headers:owner.headers});
    expect(credentialLimit.status).toBe(413);await expect(credentialLimit.json()).resolves.toMatchObject({error:"offline_snapshot_credential_limit",perAttendeeLimit:32});
  });
});
