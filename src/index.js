import { createClerkClient } from "@clerk/backend";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function allowedParties(env) {
  return String(env.AUTHORIZED_PARTIES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function clerk(env) {
  return createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
  });
}

function clerkFrontendDomain(publishableKey) {
  const encoded = String(publishableKey || "").replace(/^pk_(?:test|live)_/, "");
  if (!encoded) return "";
  try {
    return atob(encoded).replace(/\$$/, "");
  } catch {
    return "";
  }
}

function handleClerkBootstrap(request, env) {
  const hostname = new URL(request.url).hostname;
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  const publishableKey = String(
    isLocal ? env.CLERK_DEVELOPMENT_PUBLISHABLE_KEY : env.CLERK_PUBLISHABLE_KEY || ""
  );
  const frontendDomain = clerkFrontendDomain(publishableKey);
  if (!publishableKey || !frontendDomain) {
    return new Response("console.error('Clerk no está configurado');", {
      status: 503,
      headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const script = `(() => {
    const bootstrap = document.currentScript;
    const pageScript = bootstrap?.dataset.pageScript;
    const load = (src, attributes = {}) => new Promise((resolve, reject) => {
      const element = document.createElement("script");
      element.src = src;
      element.defer = true;
      Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
      element.onload = resolve;
      element.onerror = () => reject(new Error("No se pudo cargar " + src));
      document.head.appendChild(element);
    });

    (async () => {
      await load(${JSON.stringify(`https://${frontendDomain}/npm/@clerk/ui@1/dist/ui.browser.js`)}, { crossorigin: "anonymous" });
      await load(${JSON.stringify(`https://${frontendDomain}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`)}, {
        crossorigin: "anonymous",
        "data-clerk-publishable-key": ${JSON.stringify(publishableKey)},
      });
      await load("/auth.js");
      if (pageScript) await load(pageScript);
    })().catch((error) => {
      console.error("No se pudo iniciar la autenticación", error);
      window.dispatchEvent(new Event("naia:clerk-error"));
    });
  })();`;

  return new Response(script, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function authenticate(request, env) {
  if (!env.CLERK_SECRET_KEY) return { error: json({ error: "auth_not_configured" }, 503) };

  const client = clerk(env);
  const state = await client.authenticateRequest(request, {
    authorizedParties: allowedParties(env),
    acceptsToken: "session_token",
  });

  if (!state.isAuthenticated) return { error: json({ error: "unauthorized" }, 401) };

  const auth = state.toAuth();
  return { client, clerkUserId: auth.userId, sessionId: auth.sessionId };
}

async function findOrLinkPerson(env, client, clerkUserId) {
  let person = await env.DB.prepare(
    "SELECT id, clerk_user_id, email, first_name, last_name, status FROM people WHERE clerk_user_id = ?"
  ).bind(clerkUserId).first();

  if (person) return person;

  const clerkUser = await client.users.getUser(clerkUserId);
  const primaryEmail = clerkUser.emailAddresses.find((email) => email.id === clerkUser.primaryEmailAddressId);
  const email = normalizeEmail(primaryEmail?.emailAddress);
  if (!email) return null;

  const metadataPersonId = String(clerkUser.publicMetadata?.naiaPersonId || "");
  if (metadataPersonId) {
    person = await env.DB.prepare(
      "SELECT id, clerk_user_id, email, first_name, last_name, status FROM people WHERE id = ? AND email = ? COLLATE NOCASE"
    ).bind(metadataPersonId, email).first();
  }

  if (!person) {
    person = await env.DB.prepare(
      "SELECT id, clerk_user_id, email, first_name, last_name, status FROM people WHERE email = ? COLLATE NOCASE"
    ).bind(email).first();
  }

  if (!person || (person.clerk_user_id && person.clerk_user_id !== clerkUserId)) return null;

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE people SET clerk_user_id = ?, status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    ).bind(clerkUserId, person.id),
    env.DB.prepare(
      "UPDATE invitations SET status = 'accepted', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE person_id = ? AND status IN ('pending', 'sent')"
    ).bind(person.id),
  ]);

  return { ...person, clerk_user_id: clerkUserId, status: "active" };
}

async function authorizationContext(request, env, requiredPermission) {
  const authentication = await authenticate(request, env);
  if (authentication.error) return authentication;

  const person = await findOrLinkPerson(env, authentication.client, authentication.clerkUserId);
  if (!person) return { error: json({ error: "account_not_provisioned" }, 403) };
  if (person.status !== "active") return { error: json({ error: "account_inactive" }, 403) };

  const [permissionsResult, personRoles] = await Promise.all([env.DB.prepare(
    `SELECT DISTINCT rp.permission_key
       FROM person_roles pr
       JOIN role_permissions rp ON rp.role_key = pr.role_key
      WHERE pr.person_id = ?`
  ).bind(person.id).all(), rolesForPerson(env, person.id)]);
  // Every active, provisioned community member may use the document portal.
  // Global roles only add staff/system capabilities; owner, tenant and resident
  // remain unit relationships rather than fake authorization roles.
  const securityOnly = personRoles.includes("security") && !personRoles.includes("administrator");
  const permissions = [...new Set([
    ...(securityOnly ? ["reservations.read"] : ["documents.read", "reservations.read", "visitors.create"]),
    ...permissionsResult.results.map((row) => row.permission_key),
  ])];

  if (requiredPermission && !permissions.includes(requiredPermission)) {
    return { error: json({ error: "forbidden" }, 403) };
  }

  return { ...authentication, person, roles: personRoles, permissions };
}

async function rolesForPerson(env, personId) {
  const result = await env.DB.prepare(
    "SELECT role_key FROM person_roles WHERE person_id = ? ORDER BY role_key"
  ).bind(personId).all();
  return result.results.map((row) => row.role_key);
}

async function handleMe(request, env) {
  const context = await authorizationContext(request, env);
  if (context.error) return context.error;
  return json({
    person: context.person,
    roles: context.roles,
    permissions: context.permissions,
  });
}

async function handleBootstrap(request, env) {
  const authentication = await authenticate(request, env);
  if (authentication.error) return authentication.error;

  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM people").first();
  if (Number(count.count) !== 0) return json({ error: "bootstrap_already_completed" }, 409);

  const clerkUser = await authentication.client.users.getUser(authentication.clerkUserId);
  const primaryEmail = clerkUser.emailAddresses.find((email) => email.id === clerkUser.primaryEmailAddressId);
  const email = normalizeEmail(primaryEmail?.emailAddress);
  if (!email || email !== normalizeEmail(env.BOOTSTRAP_ADMIN_EMAIL)) {
    return json({ error: "bootstrap_email_mismatch" }, 403);
  }

  const personId = crypto.randomUUID();
  const firstName = String(clerkUser.firstName || "Administrador").trim();
  const lastName = String(clerkUser.lastName || "Naia").trim();
  const auditId = crypto.randomUUID();

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO people (id, clerk_user_id, email, first_name, last_name, status) VALUES (?, ?, ?, ?, ?, 'active')"
    ).bind(personId, authentication.clerkUserId, email, firstName, lastName),
    env.DB.prepare(
      "INSERT INTO person_roles (person_id, role_key, assigned_by) VALUES (?, 'administrator', ?)"
    ).bind(personId, personId),
    env.DB.prepare(
      "INSERT INTO audit_events (id, actor_person_id, action, target_type, target_id, details_json) VALUES (?, ?, 'system.bootstrap', 'person', ?, ?)"
    ).bind(auditId, personId, personId, JSON.stringify({ email })),
  ]);

  return json({ ok: true, personId }, 201);
}

async function handleRoles(request, env) {
  const context = await authorizationContext(request, env, "roles.assign");
  if (context.error) return context.error;

  const result = await env.DB.prepare(
    "SELECT key, name_es, description_es FROM roles ORDER BY name_es"
  ).all();
  return json({ roles: result.results });
}

async function listPeople(request, env) {
  const context = await authorizationContext(request, env, "people.read");
  if (context.error) return context.error;

  const result = await env.DB.prepare(
    `SELECT p.id, p.email, p.first_name, p.last_name, p.status, p.clerk_user_id,
            COALESCE(GROUP_CONCAT(pr.role_key), '') AS roles
       FROM people p
       LEFT JOIN person_roles pr ON pr.person_id = p.id
      GROUP BY p.id
      ORDER BY p.last_name, p.first_name`
  ).all();

  return json({
    people: result.results.map((person) => ({
      ...person,
      roles: person.roles ? person.roles.split(",") : [],
    })),
  });
}

async function validRoleKeys(env, roleKeys) {
  if (!Array.isArray(roleKeys)) return false;
  const unique = [...new Set(roleKeys.map(String))];
  if (unique.length !== roleKeys.length) return false;
  if (unique.length === 0) return true;
  const placeholders = unique.map(() => "?").join(",");
  const result = await env.DB.prepare(`SELECT key FROM roles WHERE key IN (${placeholders})`).bind(...unique).all();
  return result.results.length === unique.length;
}

async function createPerson(request, env) {
  const context = await authorizationContext(request, env, "people.manage");
  if (context.error) return context.error;

  const body = await request.json().catch(() => null);
  const email = normalizeEmail(body?.email);
  const firstName = String(body?.firstName || "").trim();
  const lastName = String(body?.lastName || "").trim();
  const roleKeys = Array.isArray(body?.roles) ? [...new Set(body.roles.map(String))] : [];
  const unitId = String(body?.unitId || "").trim();
  const housingRelation = String(body?.housingRelation || "").trim();
  const housingStartsOn = String(body?.housingStartsOn || "").trim();
  const allowedHousingRelations = new Set(["owner_resident", "owner_nonresident", "tenant", "authorized_occupant"]);

  if (!email || !email.includes("@") || !firstName || !lastName) {
    return json({ error: "invalid_person" }, 400);
  }
  if (!(await validRoleKeys(env, roleKeys))) return json({ error: "invalid_roles" }, 400);
  if ((unitId && (!allowedHousingRelations.has(housingRelation) || !isIsoDate(housingStartsOn)))
      || (!unitId && (housingRelation || housingStartsOn))) {
    return json({ error: "invalid_housing" }, 400);
  }
  if (unitId) {
    const unit = await env.DB.prepare("SELECT id FROM units WHERE id = ? AND active = 1").bind(unitId).first();
    if (!unit) return json({ error: "invalid_housing" }, 400);
  }

  const personId = crypto.randomUUID();
  const invitationId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const statements = [
    env.DB.prepare(
      "INSERT INTO people (id, email, first_name, last_name, status) VALUES (?, ?, ?, ?, 'pending')"
    ).bind(personId, email, firstName, lastName),
    ...roleKeys.map((roleKey) => env.DB.prepare(
      "INSERT INTO person_roles (person_id, role_key, assigned_by) VALUES (?, ?, ?)"
    ).bind(personId, roleKey, context.person.id)),
    ...((unitId && ["owner_resident", "owner_nonresident"].includes(housingRelation)) ? [
      env.DB.prepare(
        "INSERT INTO ownerships (id, person_id, unit_id, starts_on) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), personId, unitId, housingStartsOn),
    ] : []),
    ...((unitId && housingRelation !== "owner_nonresident") ? [
      env.DB.prepare(
        `INSERT INTO occupancies (id, person_id, unit_id, occupancy_type, starts_on, verified_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), personId, unitId, housingRelation, housingStartsOn, context.person.id),
    ] : []),
    env.DB.prepare(
      "INSERT INTO invitations (id, person_id, email, status, created_by) VALUES (?, ?, ?, 'pending', ?)"
    ).bind(invitationId, personId, email, context.person.id),
    env.DB.prepare(
      "INSERT INTO audit_events (id, actor_person_id, action, target_type, target_id, details_json) VALUES (?, ?, 'person.created', 'person', ?, ?)"
    ).bind(auditId, context.person.id, personId, JSON.stringify({
      email, roles: roleKeys, unitId: unitId || null, housingRelation: housingRelation || null,
    })),
  ];

  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (String(error).includes("UNIQUE")) return json({ error: "email_already_exists" }, 409);
    throw error;
  }

  try {
    const invitation = await context.client.invitations.createInvitation({
      emailAddress: email,
      redirectUrl: env.APP_URL,
      expiresInDays: 30,
      publicMetadata: { naiaPersonId: personId },
    });
    await env.DB.prepare(
      "UPDATE invitations SET clerk_invitation_id = ?, status = 'sent', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    ).bind(invitation.id, invitationId).run();
    return json({ ok: true, personId, invitationId: invitation.id }, 201);
  } catch (error) {
    await env.DB.prepare(
      "UPDATE invitations SET status = 'failed', error_message = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    ).bind(String(error).slice(0, 500), invitationId).run();
    return json({ error: "invitation_failed", personId }, 502);
  }
}

async function replaceRoles(request, env, personId) {
  const context = await authorizationContext(request, env, "roles.assign");
  if (context.error) return context.error;

  const body = await request.json().catch(() => null);
  const roleKeys = Array.isArray(body?.roles) ? [...new Set(body.roles.map(String))] : null;
  if (!roleKeys || !(await validRoleKeys(env, roleKeys))) return json({ error: "invalid_roles" }, 400);

  const target = await env.DB.prepare("SELECT id, status FROM people WHERE id = ?").bind(personId).first();
  if (!target) return json({ error: "person_not_found" }, 404);

  const currentRoles = await rolesForPerson(env, personId);
  const removesAdministrator = currentRoles.includes("administrator") && !roleKeys.includes("administrator");
  if (removesAdministrator && target.status === "active") {
    const activeAdmins = await env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM person_roles pr
         JOIN people p ON p.id = pr.person_id
        WHERE pr.role_key = 'administrator' AND p.status = 'active'`
    ).first();
    if (Number(activeAdmins.count) <= 1) return json({ error: "last_administrator" }, 409);
  }

  const removedRoles = currentRoles.filter((roleKey) => !roleKeys.includes(roleKey));
  const addedRoles = roleKeys.filter((roleKey) => !currentRoles.includes(roleKey));
  const auditId = crypto.randomUUID();

  try {
    await env.DB.batch([
    ...removedRoles.map((roleKey) => env.DB.prepare(
      "DELETE FROM person_roles WHERE person_id = ? AND role_key = ?"
    ).bind(personId, roleKey)),
    ...addedRoles.map((roleKey) => env.DB.prepare(
      "INSERT INTO person_roles (person_id, role_key, assigned_by) VALUES (?, ?, ?)"
    ).bind(personId, roleKey, context.person.id)),
    env.DB.prepare(
      "UPDATE people SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    ).bind(personId),
    env.DB.prepare(
      "INSERT INTO audit_events (id, actor_person_id, action, target_type, target_id, details_json) VALUES (?, ?, 'roles.replaced', 'person', ?, ?)"
    ).bind(auditId, context.person.id, personId, JSON.stringify({ before: currentRoles, after: roleKeys })),
    ]);
  } catch (error) {
    if (String(error).includes("last_administrator")) {
      return json({ error: "last_administrator" }, 409);
    }
    throw error;
  }

  return json({ ok: true, roles: roleKeys });
}

async function updateStatus(request, env, personId) {
  const context = await authorizationContext(request, env, "people.manage");
  if (context.error) return context.error;
  const body = await request.json().catch(() => null);
  const status = String(body?.status || "");
  if (!["active", "inactive"].includes(status)) return json({ error: "invalid_status" }, 400);

  const target = await env.DB.prepare("SELECT id, status, clerk_user_id FROM people WHERE id = ?").bind(personId).first();
  if (!target) return json({ error: "person_not_found" }, 404);

  const targetRoles = await rolesForPerson(env, personId);
  if (status === "inactive" && target.status === "active" && targetRoles.includes("administrator")) {
    const activeAdmins = await env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM person_roles pr
         JOIN people p ON p.id = pr.person_id
        WHERE pr.role_key = 'administrator' AND p.status = 'active'`
    ).first();
    if (Number(activeAdmins.count) <= 1) return json({ error: "last_administrator" }, 409);
  }

  try {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE people SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
      ).bind(status, personId),
      env.DB.prepare(
        "INSERT INTO audit_events (id, actor_person_id, action, target_type, target_id, details_json) VALUES (?, ?, 'person.status_changed', 'person', ?, ?)"
      ).bind(crypto.randomUUID(), context.person.id, personId, JSON.stringify({ before: target.status, after: status })),
    ]);
  } catch (error) {
    if (String(error).includes("last_administrator")) {
      return json({ error: "last_administrator" }, 409);
    }
    throw error;
  }

  if (status === "inactive" && target.clerk_user_id) {
    const sessions = await context.client.sessions.getSessionList({ userId: target.clerk_user_id });
    await Promise.all(sessions.data.map((session) => context.client.sessions.revokeSession(session.id)));
  }

  return json({ ok: true, status });
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const date = new Date(`${value}T12:00:00-06:00`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function costaRicaDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Costa_Rica",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function reservationInstant(date, time) {
  return new Date(`${date}T${time}:00-06:00`);
}

function isoUtcDate(date) {
  return date.toISOString().slice(0, 10);
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function costaRicaHoliday(date) {
  if (!isIsoDate(date)) return null;
  const fixed = {
    "01-01": "Año Nuevo",
    "04-11": "Día de Juan Santamaría",
    "05-01": "Día Internacional del Trabajo",
    "07-25": "Anexión del Partido de Nicoya",
    "08-02": "Día de la Virgen de los Ángeles",
    "08-15": "Día de la Madre",
    "08-31": "Día de la Persona Negra y la Cultura Afrocostarricense",
    "09-15": "Día de la Independencia",
    "12-01": "Día de la Abolición del Ejército",
    "12-25": "Navidad",
  };
  const fixedName = fixed[date.slice(5)];
  if (fixedName) return fixedName;
  const easter = easterSunday(Number(date.slice(0, 4)));
  const holyThursday = new Date(easter);
  holyThursday.setUTCDate(easter.getUTCDate() - 3);
  if (isoUtcDate(holyThursday) === date) return "Jueves Santo";
  const goodFriday = new Date(easter);
  goodFriday.setUTCDate(easter.getUTCDate() - 2);
  if (isoUtcDate(goodFriday) === date) return "Viernes Santo";
  return null;
}

function holidaysBetween(from, to) {
  const holidays = [];
  const cursor = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (cursor <= end) {
    const date = isoUtcDate(cursor);
    const name = costaRicaHoliday(date);
    if (name) holidays.push({ date, name });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return holidays;
}

async function eligibleUnits(env, personId, onDate) {
  const result = await env.DB.prepare(
    `SELECT u.id, u.number, u.reservations_enabled, u.reservation_block_reason,
            o.occupancy_type, o.starts_on, o.ends_on
       FROM occupancies o
       JOIN units u ON u.id = o.unit_id
      WHERE o.person_id = ?
        AND o.starts_on <= ?
        AND (o.ends_on IS NULL OR o.ends_on >= ?)
        AND u.active = 1
      ORDER BY CAST(u.number AS INTEGER), u.number`
  ).bind(personId, onDate, onDate).all();
  return result.results;
}

function parseCostaRicaDateTime(value) {
  const normalized = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) return null;
  const instant = new Date(`${normalized}:00-06:00`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

function dateTimeLocalValue(instant) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(instant);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}

function recurringOccurrenceInstant(date, time) {
  return new Date(`${date}T${time}:00-06:00`);
}

function visitorOccurrences(authorization, from, to) {
  if (!authorization.active) return [];
  if (authorization.schedule_type === "one_time") {
    const local = dateTimeLocalValue(new Date(authorization.one_time_at));
    const date = local.slice(0, 10);
    return date >= from && date <= to ? [{ date, scheduledFor: authorization.one_time_at }] : [];
  }
  let weekdays;
  try { weekdays = JSON.parse(authorization.weekdays_json); } catch { weekdays = []; }
  const allowed = new Set(weekdays.map(Number));
  const start = authorization.recurring_start_date > from ? authorization.recurring_start_date : from;
  const end = authorization.recurring_end_date < to ? authorization.recurring_end_date : to;
  if (end < start) return [];
  const cursor = new Date(`${start}T12:00:00Z`);
  const finish = new Date(`${end}T12:00:00Z`);
  const occurrences = [];
  while (cursor <= finish) {
    const date = cursor.toISOString().slice(0, 10);
    if (allowed.has(cursor.getUTCDay())) {
      occurrences.push({ date, scheduledFor: recurringOccurrenceInstant(date, authorization.recurring_time).toISOString() });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return occurrences;
}

async function listOwnVisitors(request, env) {
  const context = await authorizationContext(request, env, "visitors.create");
  if (context.error) return context.error;
  const units = await eligibleUnits(env, context.person.id, costaRicaDate());
  const authorizations = await env.DB.prepare(
    `SELECT va.*, u.number AS unit_number
       FROM visitor_authorizations va JOIN units u ON u.id = va.unit_id
      WHERE va.created_by_person_id = ?
      ORDER BY va.active DESC, va.created_at DESC`
  ).bind(context.person.id).all();
  return json({ units, authorizations: authorizations.results });
}

async function createVisitorAuthorization(request, env) {
  const context = await authorizationContext(request, env, "visitors.create");
  if (context.error) return context.error;
  const body = await request.json().catch(() => null);
  const unitId = String(body?.unitId || "");
  const visitorName = String(body?.visitorName || "").trim().slice(0, 120);
  const visitorType = String(body?.visitorType || "");
  const scheduleType = String(body?.scheduleType || "");
  const vehiclePlate = String(body?.vehiclePlate || "").trim().slice(0, 30) || null;
  const notes = String(body?.notes || "").trim().slice(0, 800) || null;
  const allowedTypes = new Set(["guest", "delivery", "domestic_worker", "service", "contractor", "transport", "other"]);
  if (!unitId || !visitorName || !allowedTypes.has(visitorType) || !["one_time", "weekly"].includes(scheduleType)) {
    return json({ error: "invalid_visitor_authorization" }, 400);
  }

  let oneTimeAt = null;
  let startDate = null;
  let endDate = null;
  let recurringTime = null;
  let weekdays = [];
  let openEnded = false;
  if (scheduleType === "one_time") {
    const instant = parseCostaRicaDateTime(body.oneTimeAt);
    if (!instant || instant.getTime() < Date.now() - 15 * 60000) return json({ error: "invalid_visit_time" }, 400);
    oneTimeAt = instant.toISOString();
    startDate = String(body.oneTimeAt).slice(0, 10);
    endDate = startDate;
  } else {
    startDate = String(body.startDate || "");
    openEnded = body.openEnded === true;
    endDate = openEnded ? "9999-12-31" : String(body.endDate || "");
    recurringTime = String(body.recurringTime || "");
    weekdays = [...new Set((Array.isArray(body.weekdays) ? body.weekdays : []).map(Number))]
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort();
    const span = new Date(`${endDate}T12:00:00Z`).getTime() - new Date(`${startDate}T12:00:00Z`).getTime();
    if (!isIsoDate(startDate) || !isIsoDate(endDate) || endDate < startDate || (!openEnded && span > 366 * 86400000)
        || !/^([01]\d|2[0-3]):[0-5]\d$/.test(recurringTime) || weekdays.length === 0) {
      return json({ error: "invalid_recurring_schedule" }, 400);
    }
  }

  const eligibleAtStart = await eligibleUnits(env, context.person.id, startDate);
  const startingUnit = eligibleAtStart.find((unit) => unit.id === unitId);
  if (openEnded && startingUnit) endDate = startingUnit.ends_on || "9999-12-31";
  const eligibleAtEnd = await eligibleUnits(env, context.person.id, endDate);
  if (!startingUnit || !eligibleAtEnd.some((unit) => unit.id === unitId)) {
    return json({ error: "not_current_resident" }, 403);
  }

  const authorizationId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO visitor_authorizations
        (id, unit_id, created_by_person_id, visitor_name, visitor_type, vehicle_plate, notes,
         schedule_type, one_time_at, recurring_start_date, recurring_end_date, recurring_time, weekdays_json, open_ended)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(authorizationId, unitId, context.person.id, visitorName, visitorType, vehiclePlate, notes,
      scheduleType, oneTimeAt, scheduleType === "weekly" ? startDate : null,
      scheduleType === "weekly" ? endDate : null, recurringTime, JSON.stringify(weekdays),
      scheduleType === "weekly" && openEnded ? 1 : 0),
    env.DB.prepare(
      `INSERT INTO audit_events (id, actor_person_id, action, target_type, target_id, details_json)
       VALUES (?, ?, 'visitor.authorization_created', 'visitor_authorization', ?, ?)`
    ).bind(crypto.randomUUID(), context.person.id, authorizationId, JSON.stringify({ unitId, scheduleType })),
  ]);
  return json({ ok: true, authorizationId }, 201);
}

async function cancelVisitorAuthorization(request, env, authorizationId) {
  const context = await authorizationContext(request, env, "visitors.create");
  if (context.error) return context.error;
  const authorization = await env.DB.prepare(
    "SELECT id, created_by_person_id, active FROM visitor_authorizations WHERE id = ?"
  ).bind(authorizationId).first();
  if (!authorization) return json({ error: "visitor_authorization_not_found" }, 404);
  const manages = context.permissions.includes("visitors.manage");
  if (!manages && authorization.created_by_person_id !== context.person.id) return json({ error: "forbidden" }, 403);
  if (!authorization.active) return json({ error: "visitor_authorization_inactive" }, 409);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE visitor_authorizations SET active = 0, cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              cancelled_by_person_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
    ).bind(context.person.id, authorizationId),
    env.DB.prepare(
      `INSERT INTO audit_events (id, actor_person_id, action, target_type, target_id)
       VALUES (?, ?, 'visitor.authorization_cancelled', 'visitor_authorization', ?)`
    ).bind(crypto.randomUUID(), context.person.id, authorizationId),
  ]);
  return json({ ok: true });
}

async function listSecurityVisits(request, env, url) {
  const context = await authorizationContext(request, env, "visitors.read");
  if (context.error) return context.error;
  const from = url.searchParams.get("from") || costaRicaDate();
  const to = url.searchParams.get("to") || from;
  if (!isIsoDate(from) || !isIsoDate(to) || to < from
      || new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`) > 31 * 86400000) {
    return json({ error: "invalid_date_range" }, 400);
  }
  const [authorizations, events, units] = await Promise.all([
    env.DB.prepare(
      `SELECT va.*, u.number AS unit_number, p.first_name AS creator_first_name, p.last_name AS creator_last_name
         FROM visitor_authorizations va
         JOIN units u ON u.id = va.unit_id
         JOIN people p ON p.id = va.created_by_person_id
        WHERE va.active = 1
          AND ((va.schedule_type = 'one_time' AND date(va.one_time_at, '-6 hours') BETWEEN ? AND ?)
            OR (va.schedule_type = 'weekly' AND va.recurring_start_date <= ? AND va.recurring_end_date >= ?))
        ORDER BY u.number, va.visitor_name`
    ).bind(from, to, to, from).all(),
    env.DB.prepare(
      `SELECT e.*, p.first_name AS recorder_first_name, p.last_name AS recorder_last_name
         FROM visitor_access_events e JOIN people p ON p.id = e.recorded_by_person_id
        WHERE date(e.scheduled_for, '-6 hours') BETWEEN ? AND ?`
    ).bind(from, to).all(),
    env.DB.prepare("SELECT id, number FROM units WHERE active = 1 ORDER BY CAST(number AS INTEGER), number").all(),
  ]);
  const eventMap = new Map(events.results.map((event) => [`${event.authorization_id}|${event.scheduled_for}`, event]));
  const visits = authorizations.results.flatMap((authorization) => visitorOccurrences(authorization, from, to)
    .map((occurrence) => ({ ...authorization, ...occurrence,
      event: eventMap.get(`${authorization.id}|${occurrence.scheduledFor}`) || null })));
  visits.sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor) || a.unit_number.localeCompare(b.unit_number));
  return json({ from, to, units: units.results, visits });
}

async function recordVisitorOutcome(request, env, authorizationId) {
  const context = await authorizationContext(request, env, "visitors.manage");
  if (context.error) return context.error;
  const body = await request.json().catch(() => null);
  const scheduledFor = String(body?.scheduledFor || "");
  const outcome = String(body?.outcome || "");
  const notes = String(body?.notes || "").trim().slice(0, 800) || null;
  const allowedOutcomes = new Set(["allowed_resident_authorized", "allowed_administration_authorized",
    "denied_resident", "denied_documents", "denied_protocol", "cancelled_by_visitor", "no_show"]);
  if (!allowedOutcomes.has(outcome) || Number.isNaN(new Date(scheduledFor).getTime())) {
    return json({ error: "invalid_visit_outcome" }, 400);
  }
  const authorization = await env.DB.prepare("SELECT * FROM visitor_authorizations WHERE id = ? AND active = 1")
    .bind(authorizationId).first();
  if (!authorization) return json({ error: "visitor_authorization_not_found" }, 404);
  const localDate = dateTimeLocalValue(new Date(scheduledFor)).slice(0, 10);
  const validOccurrence = visitorOccurrences(authorization, localDate, localDate)
    .some((occurrence) => occurrence.scheduledFor === scheduledFor);
  if (!validOccurrence) return json({ error: "invalid_visit_occurrence" }, 400);
  const eventId = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO visitor_access_events
          (id, authorization_id, unit_id, visitor_name, scheduled_for, outcome, notes, recorded_by_person_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(eventId, authorizationId, authorization.unit_id, authorization.visitor_name, scheduledFor,
        outcome, notes, context.person.id),
      env.DB.prepare(
        `INSERT INTO audit_events (id, actor_person_id, action, target_type, target_id, details_json)
         VALUES (?, ?, 'visitor.outcome_recorded', 'visitor_access_event', ?, ?)`
      ).bind(crypto.randomUUID(), context.person.id, eventId, JSON.stringify({ authorizationId, scheduledFor, outcome })),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) return json({ error: "visit_outcome_already_recorded" }, 409);
    throw error;
  }
  return json({ ok: true, eventId }, 201);
}

const SECURITY_RELEASE_CHECKLIST = [
  "responsible_verified",
  "area_inspected",
  "rules_reviewed",
  "schedule_confirmed",
];

async function listSecurityReservations(request, env, url) {
  const context = await authorizationContext(request, env, "reservations.read_details");
  if (context.error) return context.error;
  const from = url.searchParams.get("from") || costaRicaDate();
  const to = url.searchParams.get("to") || from;
  if (!isIsoDate(from) || !isIsoDate(to) || to < from
      || new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`) > 31 * 86400000) {
    return json({ error: "invalid_date_range" }, 400);
  }
  const reservations = await env.DB.prepare(
    `SELECT r.id, r.area_id, r.slot_id, r.unit_id, r.reservation_date, r.starts_at, r.ends_at,
            r.status, r.guest_count, r.notes, a.name AS area_name, a.color AS area_color,
            a.terms_text, s.name AS slot_name, u.number AS unit_number,
            p.first_name AS resident_first_name, p.last_name AS resident_last_name,
            rel.release_type, rel.checklist_json AS release_checklist_json, rel.notes AS release_notes,
            rel.completed_at AS released_at, rp.first_name AS released_by_first_name,
            rp.last_name AS released_by_last_name
       FROM reservations r
       JOIN reservable_areas a ON a.id = r.area_id
       JOIN area_time_slots s ON s.id = r.slot_id
       JOIN units u ON u.id = r.unit_id
       JOIN people p ON p.id = r.created_by_person_id
       LEFT JOIN reservation_security_releases rel ON rel.reservation_id = r.id
       LEFT JOIN people rp ON rp.id = rel.completed_by_person_id
      WHERE r.reservation_date BETWEEN ? AND ? AND r.status IN ('pending', 'confirmed')
      ORDER BY r.reservation_date, r.starts_at, a.name`
  ).bind(from, to).all();
  return json({ from, to, reservations: reservations.results });
}

async function releaseReservationForUse(request, env, reservationId) {
  const context = await authorizationContext(request, env, "reservations.release");
  if (context.error) return context.error;
  const body = await request.json().catch(() => null);
  const reservation = await env.DB.prepare(
    `SELECT r.id, r.status, r.reservation_date, r.area_id, a.name AS area_name
       FROM reservations r JOIN reservable_areas a ON a.id = r.area_id WHERE r.id = ?`
  ).bind(reservationId).first();
  if (!reservation) return json({ error: "reservation_not_found" }, 404);
  if (reservation.status !== "confirmed") return json({ error: "reservation_not_confirmed" }, 409);
  if (reservation.reservation_date !== costaRicaDate()) return json({ error: "reservation_release_wrong_day" }, 409);
  const releaseType = reservation.area_id === "area-spa" || /spa/i.test(reservation.area_name)
    ? "access_key" : "checklist";
  const checklist = [...new Set((Array.isArray(body?.checklist) ? body.checklist : []).map(String))];
  if (releaseType === "checklist" && !SECURITY_RELEASE_CHECKLIST.every((item) => checklist.includes(item))) {
    return json({ error: "incomplete_release_checklist" }, 400);
  }
  const notes = String(body?.notes || "").trim().slice(0, 1000) || null;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO reservation_security_releases
          (reservation_id, release_type, checklist_json, notes, completed_by_person_id)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(reservationId, releaseType, JSON.stringify(releaseType === "checklist" ? checklist : []),
        notes, context.person.id),
      env.DB.prepare(
        `INSERT INTO audit_events (id, actor_person_id, action, target_type, target_id, details_json)
         VALUES (?, ?, 'reservation.security_released', 'reservation', ?, ?)`
      ).bind(crypto.randomUUID(), context.person.id, reservationId, JSON.stringify({ releaseType, checklist })),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) return json({ error: "reservation_already_released" }, 409);
    throw error;
  }
  return json({ ok: true, releaseType }, 201);
}

async function listSecurityIncidents(request, env, url) {
  const context = await authorizationContext(request, env, "security.incidents.read");
  if (context.error) return context.error;
  const from = url.searchParams.get("from") || costaRicaDate();
  const to = url.searchParams.get("to") || from;
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) return json({ error: "invalid_date_range" }, 400);
  const incidents = await env.DB.prepare(
    `SELECT i.*, p.first_name AS creator_first_name, p.last_name AS creator_last_name
       FROM security_incidents i JOIN people p ON p.id = i.created_by_person_id
      WHERE date(i.occurred_at, '-6 hours') BETWEEN ? AND ? ORDER BY i.occurred_at DESC LIMIT 250`
  ).bind(from, to).all();
  return json({ incidents: incidents.results });
}

async function createSecurityIncident(request, env) {
  const context = await authorizationContext(request, env, "security.incidents.manage");
  if (context.error) return context.error;
  const body = await request.json().catch(() => null);
  const occurred = parseCostaRicaDateTime(body?.occurredAt);
  const description = String(body?.description || "").trim().slice(0, 4000);
  if (!occurred || description.length < 5) return json({ error: "invalid_security_incident" }, 400);
  const incidentId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO security_incidents (id, occurred_at, description, created_by_person_id) VALUES (?, ?, ?, ?)"
    ).bind(incidentId, occurred.toISOString(), description, context.person.id),
    env.DB.prepare(
      `INSERT INTO audit_events (id, actor_person_id, action, target_type, target_id)
       VALUES (?, ?, 'security.incident_created', 'security_incident', ?)`
    ).bind(crypto.randomUUID(), context.person.id, incidentId),
  ]);
  return json({ ok: true, incidentId }, 201);
}

async function handleReservationEligibility(request, env, url) {
  const context = await authorizationContext(request, env);
  if (context.error) return context.error;
  const onDate = url.searchParams.get("date") || costaRicaDate();
  if (!isIsoDate(onDate)) return json({ error: "invalid_date" }, 400);
  const units = await eligibleUnits(env, context.person.id, onDate);
  let activeReservations = [];
  if (units.length) {
    const placeholders = units.map(() => "?").join(",");
    const activeResult = await env.DB.prepare(
      `SELECT id, unit_id, area_id, reservation_date, starts_at, ends_at, status
         FROM reservations
        WHERE unit_id IN (${placeholders})
          AND status IN ('pending', 'confirmed')
          AND datetime(reservation_date || 'T' || ends_at || ':00-06:00') > datetime('now')
        ORDER BY reservation_date, starts_at`
    ).bind(...units.map((unit) => unit.id)).all();
    activeReservations = activeResult.results;
  }
  return json({
    date: onDate,
    canCreate: units.some((unit) => Boolean(unit.reservations_enabled)),
    units,
    activeReservations,
  });
}

async function handleReservationCalendar(request, env, url) {
  const context = await authorizationContext(request, env, "reservations.read");
  if (context.error) return context.error;
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) return json({ error: "invalid_range" }, 400);
  const rangeDays = Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86400000);
  if (rangeDays > 62) return json({ error: "range_too_large" }, 400);

  const [areasResult, slotsResult, reservationsResult] = await Promise.all([
    env.DB.prepare(
      `SELECT a.*, r.min_notice_minutes, r.max_advance_days,
              r.max_reservations_per_unit_month, r.cancellation_cutoff_minutes,
              r.max_guests, r.fee_cents, r.deposit_cents, r.requires_approval,
              r.allow_sundays, r.allow_holidays
         FROM reservable_areas a
         JOIN area_reservation_rules r ON r.area_id = a.id
        WHERE a.active = 1
        ORDER BY a.name`
    ).all(),
    env.DB.prepare(
      `SELECT s.* FROM area_time_slots s
        JOIN reservable_areas a ON a.id = s.area_id
       WHERE a.active = 1 AND s.active = 1
       ORDER BY s.area_id, s.display_order, s.starts_at`
    ).all(),
    env.DB.prepare(
      `SELECT r.id, r.area_id, r.slot_id, r.unit_id, r.created_by_person_id,
              r.reservation_date, r.starts_at, r.ends_at, r.status,
              r.guest_count, r.notes, u.number AS unit_number,
              p.first_name, p.last_name
         FROM reservations r
         JOIN units u ON u.id = r.unit_id
         JOIN people p ON p.id = r.created_by_person_id
        WHERE r.reservation_date BETWEEN ? AND ?
          AND r.status IN ('pending', 'confirmed')
        ORDER BY r.reservation_date, r.starts_at`
    ).bind(from, to).all(),
  ]);

  const showDetails = context.permissions.includes("reservations.read_details");
  return json({
    areas: areasResult.results,
    slots: slotsResult.results,
    reservations: reservationsResult.results.map((reservation) => showDetails ? {
      ...reservation,
      is_own: reservation.created_by_person_id === context.person.id,
    } : {
      id: reservation.id,
      area_id: reservation.area_id,
      slot_id: reservation.slot_id,
      reservation_date: reservation.reservation_date,
      starts_at: reservation.starts_at,
      ends_at: reservation.ends_at,
      status: reservation.status,
      is_own: reservation.created_by_person_id === context.person.id,
    }),
    canSeeDetails: showDetails,
    holidays: holidaysBetween(from, to),
  });
}

async function createReservation(request, env) {
  const context = await authorizationContext(request, env);
  if (context.error) return context.error;
  const requesterRoles = await rolesForPerson(env, context.person.id);
  if (requesterRoles.includes("security") && !requesterRoles.includes("administrator")) {
    return json({ error: "security_read_only" }, 403);
  }
  const body = await request.json().catch(() => null);
  const date = String(body?.date || "");
  const areaId = String(body?.areaId || "");
  const slotId = String(body?.slotId || "");
  const unitId = String(body?.unitId || "");
  const guestCount = Number(body?.guestCount || 0);
  const notes = String(body?.notes || "").trim().slice(0, 500);
  if (!isIsoDate(date) || !areaId || !slotId || !unitId || !Number.isInteger(guestCount) || guestCount < 0) {
    return json({ error: "invalid_reservation" }, 400);
  }

  const slot = await env.DB.prepare(
    `SELECT s.id, s.area_id, s.name, s.day_of_week, s.starts_at, s.ends_at,
            a.name AS area_name, a.capacity, a.active, a.terms_text,
            rr.min_notice_minutes, rr.max_advance_days,
            rr.max_reservations_per_unit_month, rr.max_guests,
            rr.requires_approval, rr.allow_sundays, rr.allow_holidays
       FROM area_time_slots s
       JOIN reservable_areas a ON a.id = s.area_id
       JOIN area_reservation_rules rr ON rr.area_id = a.id
      WHERE s.id = ? AND s.area_id = ? AND s.active = 1`
  ).bind(slotId, areaId).first();
  if (!slot || !slot.active) return json({ error: "area_or_slot_unavailable" }, 404);

  const dayOfWeek = new Date(`${date}T12:00:00-06:00`).getUTCDay();
  if (dayOfWeek === 0 && !slot.allow_sundays) {
    return json({ error: "sunday_not_reservable" }, 409);
  }
  const holiday = costaRicaHoliday(date);
  if (holiday && !slot.allow_holidays) {
    return json({ error: "holiday_not_reservable", holiday }, 409);
  }
  if (slot.day_of_week !== null && Number(slot.day_of_week) !== dayOfWeek) {
    return json({ error: "slot_not_available_that_day" }, 409);
  }

  const starts = reservationInstant(date, slot.starts_at);
  const now = new Date();
  if (starts.getTime() < now.getTime() + Number(slot.min_notice_minutes) * 60000) {
    return json({ error: "notice_period" }, 409);
  }
  const today = costaRicaDate(now);
  const advanceDays = Math.round((new Date(`${date}T12:00:00Z`) - new Date(`${today}T12:00:00Z`)) / 86400000);
  if (advanceDays > Number(slot.max_advance_days)) return json({ error: "advance_limit" }, 409);
  if (slot.max_guests !== null && guestCount > Number(slot.max_guests)) return json({ error: "guest_limit" }, 409);

  const units = await eligibleUnits(env, context.person.id, date);
  const unit = units.find((candidate) => candidate.id === unitId);
  if (!unit) return json({ error: "not_current_resident" }, 403);
  if (!unit.reservations_enabled) return json({ error: "unit_reservations_suspended", reason: unit.reservation_block_reason }, 403);

  const activeAreaReservation = await env.DB.prepare(
    `SELECT id, reservation_date, starts_at, ends_at, status
       FROM reservations
      WHERE unit_id = ? AND area_id = ?
        AND status IN ('pending', 'confirmed')
        AND datetime(reservation_date || 'T' || ends_at || ':00-06:00') > datetime('now')
      ORDER BY reservation_date, starts_at
      LIMIT 1`
  ).bind(unitId, areaId).first();
  if (activeAreaReservation) {
    return json({ error: "unit_area_active_reservation", reservation: activeAreaReservation }, 409);
  }

  if (slot.max_reservations_per_unit_month !== null) {
    const monthStart = `${date.slice(0, 7)}-01`;
    const nextMonth = new Date(`${monthStart}T12:00:00Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const monthEnd = new Date(nextMonth.getTime() - 86400000).toISOString().slice(0, 10);
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM reservations
        WHERE unit_id = ? AND area_id = ?
          AND reservation_date BETWEEN ? AND ?
          AND status IN ('pending', 'confirmed')`
    ).bind(unitId, areaId, monthStart, monthEnd).first();
    if (Number(count.count) >= Number(slot.max_reservations_per_unit_month)) {
      return json({ error: "monthly_limit" }, 409);
    }
  }

  const reservationId = crypto.randomUUID();
  const status = slot.requires_approval ? "pending" : "confirmed";
  try {
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM unit_area_reservation_locks
          WHERE unit_id = ? AND area_id = ?
            AND reservation_id IN (
              SELECT id FROM reservations
               WHERE status NOT IN ('pending', 'confirmed')
                  OR datetime(reservation_date || 'T' || ends_at || ':00-06:00') <= datetime('now')
            )`
      ).bind(unitId, areaId),
      env.DB.prepare(
        `INSERT INTO reservations
          (id, area_id, slot_id, unit_id, created_by_person_id, reservation_date,
           starts_at, ends_at, status, guest_count, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(reservationId, areaId, slotId, unitId, context.person.id, date,
        slot.starts_at, slot.ends_at, status, guestCount, notes),
      env.DB.prepare(
        `INSERT INTO unit_area_reservation_locks (unit_id, area_id, reservation_id)
         VALUES (?, ?, ?)`
      ).bind(unitId, areaId, reservationId),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, actor_person_id, action, target_type, target_id, details_json)
         VALUES (?, ?, 'reservation.created', 'reservation', ?, ?)`
      ).bind(crypto.randomUUID(), context.person.id, reservationId,
        JSON.stringify({ areaId, slotId, unitId, date, status })),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      const [unitConflict, slotConflict] = await Promise.all([
        env.DB.prepare(
          `SELECT id FROM reservations
            WHERE unit_id = ? AND area_id = ?
              AND status IN ('pending', 'confirmed')
              AND datetime(reservation_date || 'T' || ends_at || ':00-06:00') > datetime('now')
            LIMIT 1`
        ).bind(unitId, areaId).first(),
        env.DB.prepare(
          `SELECT id FROM reservations
            WHERE area_id = ? AND reservation_date = ? AND slot_id = ?
              AND status IN ('pending', 'confirmed')
            LIMIT 1`
        ).bind(areaId, date, slotId).first(),
      ]);
      if (unitConflict) return json({ error: "unit_area_active_reservation" }, 409);
      if (slotConflict) return json({ error: "slot_unavailable" }, 409);
    }
    throw error;
  }
  return json({ ok: true, reservationId, status }, 201);
}

async function cancelReservation(request, env, reservationId) {
  const context = await authorizationContext(request, env);
  if (context.error) return context.error;
  const reservation = await env.DB.prepare(
    `SELECT r.*, rr.cancellation_cutoff_minutes
       FROM reservations r
       JOIN area_reservation_rules rr ON rr.area_id = r.area_id
      WHERE r.id = ?`
  ).bind(reservationId).first();
  if (!reservation) return json({ error: "reservation_not_found" }, 404);
  const manages = context.permissions.includes("reservations.manage");
  if (!manages && reservation.created_by_person_id !== context.person.id) return json({ error: "forbidden" }, 403);
  if (!['pending', 'confirmed'].includes(reservation.status)) return json({ error: "reservation_not_active" }, 409);
  const cutoff = reservationInstant(reservation.reservation_date, reservation.starts_at).getTime()
    - Number(reservation.cancellation_cutoff_minutes) * 60000;
  if (!manages && Date.now() > cutoff) return json({ error: "cancellation_cutoff" }, 409);

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE reservations SET status = 'cancelled', cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              cancelled_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?`
    ).bind(context.person.id, reservationId),
    env.DB.prepare("DELETE FROM unit_area_reservation_locks WHERE reservation_id = ?").bind(reservationId),
    env.DB.prepare(
      `INSERT INTO audit_events (id, actor_person_id, action, target_type, target_id)
       VALUES (?, ?, 'reservation.cancelled', 'reservation', ?)`
    ).bind(crypto.randomUUID(), context.person.id, reservationId),
  ]);
  return json({ ok: true });
}

async function updateReservationStatus(request, env, reservationId) {
  const context = await authorizationContext(request, env, "reservations.manage");
  if (context.error) return context.error;
  const body = await request.json().catch(() => null);
  const status = String(body?.status || "");
  if (!['confirmed', 'rejected'].includes(status)) return json({ error: "invalid_reservation_status" }, 400);
  const reservation = await env.DB.prepare("SELECT id, status FROM reservations WHERE id = ?").bind(reservationId).first();
  if (!reservation) return json({ error: "reservation_not_found" }, 404);
  if (reservation.status !== "pending") return json({ error: "reservation_not_pending" }, 409);
  const statements = [
    env.DB.prepare(
      "UPDATE reservations SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    ).bind(status, reservationId),
    env.DB.prepare(
      `INSERT INTO audit_events (id, actor_person_id, action, target_type, target_id, details_json)
       VALUES (?, ?, 'reservation.status_changed', 'reservation', ?, ?)`
    ).bind(crypto.randomUUID(), context.person.id, reservationId, JSON.stringify({ before: reservation.status, after: status })),
  ];
  if (status === "rejected") {
    statements.splice(1, 0,
      env.DB.prepare("DELETE FROM unit_area_reservation_locks WHERE reservation_id = ?").bind(reservationId));
  }
  await env.DB.batch(statements);
  return json({ ok: true, status });
}

async function listReservableAreas(request, env) {
  const context = await authorizationContext(request, env, "reservations.manage");
  if (context.error) return context.error;
  const [areas, slots] = await Promise.all([
    env.DB.prepare(
      `SELECT a.*, r.min_notice_minutes, r.max_advance_days,
              r.max_reservations_per_unit_month, r.cancellation_cutoff_minutes,
              r.max_guests, r.fee_cents, r.deposit_cents, r.requires_approval,
              r.allow_sundays, r.allow_holidays
         FROM reservable_areas a JOIN area_reservation_rules r ON r.area_id = a.id
        ORDER BY a.name`
    ).all(),
    env.DB.prepare("SELECT * FROM area_time_slots ORDER BY area_id, display_order, starts_at").all(),
  ]);
  return json({
    areas: areas.results.map((area) => ({
      ...area,
      slots: slots.results.filter((slot) => slot.area_id === area.id),
    })),
  });
}

function normalizeArea(body) {
  const name = String(body?.name || "").trim();
  const description = String(body?.description || "").trim();
  const color = /^#[0-9A-Fa-f]{6}$/.test(String(body?.color || "")) ? body.color : "#A84132";
  const capacity = body?.capacity === "" || body?.capacity == null ? null : Number(body.capacity);
  const maxGuests = body?.maxGuests === "" || body?.maxGuests == null ? null : Number(body.maxGuests);
  const monthlyLimit = body?.monthlyLimit === "" || body?.monthlyLimit == null ? null : Number(body.monthlyLimit);
  const slots = Array.isArray(body?.slots) ? body.slots.map((slot, index) => ({
    id: String(slot.id || crypto.randomUUID()),
    name: String(slot.name || "").trim(),
    startsAt: String(slot.startsAt || ""),
    endsAt: String(slot.endsAt || ""),
    dayOfWeek: slot.dayOfWeek === "" || slot.dayOfWeek == null ? null : Number(slot.dayOfWeek),
    active: slot.active !== false,
    displayOrder: index,
  })) : [];
  const validTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  const valid = name && (capacity === null || (Number.isInteger(capacity) && capacity > 0))
    && (maxGuests === null || (Number.isInteger(maxGuests) && maxGuests >= 0))
    && (monthlyLimit === null || (Number.isInteger(monthlyLimit) && monthlyLimit > 0))
    && slots.every((slot) => slot.name && validTime(slot.startsAt) && validTime(slot.endsAt)
      && slot.endsAt > slot.startsAt && (slot.dayOfWeek === null || Number.isInteger(slot.dayOfWeek) && slot.dayOfWeek >= 0 && slot.dayOfWeek <= 6));
  return {
    valid: Boolean(valid), name, description, color, capacity,
    active: body?.active !== false,
    termsText: String(body?.termsText || "").trim(),
    minNoticeMinutes: Math.max(0, Number(body?.minNoticeHours || 0) * 60),
    maxAdvanceDays: Math.max(0, Number(body?.maxAdvanceDays ?? 365)),
    monthlyLimit,
    cancellationCutoffMinutes: Math.max(0, Number(body?.cancellationHours || 0) * 60),
    maxGuests,
    feeCents: Math.max(0, Math.round(Number(body?.fee || 0) * 100)),
    depositCents: Math.max(0, Math.round(Number(body?.deposit || 0) * 100)),
    requiresApproval: Boolean(body?.requiresApproval),
    allowSundays: Boolean(body?.allowSundays),
    allowHolidays: Boolean(body?.allowHolidays),
    slots,
  };
}

async function createReservableArea(request, env) {
  const context = await authorizationContext(request, env, "reservations.manage");
  if (context.error) return context.error;
  const area = normalizeArea(await request.json().catch(() => null));
  if (!area.valid) return json({ error: "invalid_area" }, 400);
  const areaId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO reservable_areas
        (id, name, description, color, capacity, active, terms_text, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(areaId, area.name, area.description, area.color, area.capacity, area.active ? 1 : 0, area.termsText, context.person.id),
    env.DB.prepare(
      `INSERT INTO area_reservation_rules
        (area_id, min_notice_minutes, max_advance_days, max_reservations_per_unit_month,
         cancellation_cutoff_minutes, max_guests, fee_cents, deposit_cents, requires_approval,
         allow_sundays, allow_holidays)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(areaId, area.minNoticeMinutes, area.maxAdvanceDays, area.monthlyLimit,
      area.cancellationCutoffMinutes, area.maxGuests, area.feeCents, area.depositCents,
      area.requiresApproval ? 1 : 0, area.allowSundays ? 1 : 0, area.allowHolidays ? 1 : 0),
    ...area.slots.map((slot) => env.DB.prepare(
      `INSERT INTO area_time_slots
        (id, area_id, name, day_of_week, starts_at, ends_at, active, display_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(slot.id, areaId, slot.name, slot.dayOfWeek, slot.startsAt, slot.endsAt, slot.active ? 1 : 0, slot.displayOrder)),
    env.DB.prepare(
      `INSERT INTO audit_events (id, actor_person_id, action, target_type, target_id)
       VALUES (?, ?, 'reservable_area.created', 'reservable_area', ?)`
    ).bind(crypto.randomUUID(), context.person.id, areaId),
  ]);
  return json({ ok: true, areaId }, 201);
}

async function updateReservableArea(request, env, areaId) {
  const context = await authorizationContext(request, env, "reservations.manage");
  if (context.error) return context.error;
  const existing = await env.DB.prepare("SELECT id FROM reservable_areas WHERE id = ?").bind(areaId).first();
  if (!existing) return json({ error: "area_not_found" }, 404);
  const area = normalizeArea(await request.json().catch(() => null));
  if (!area.valid) return json({ error: "invalid_area" }, 400);
  const existingSlots = await env.DB.prepare("SELECT id FROM area_time_slots WHERE area_id = ?").bind(areaId).all();
  const knownIds = new Set(existingSlots.results.map((slot) => slot.id));
  const incomingIds = new Set(area.slots.map((slot) => slot.id));
  const statements = [
    env.DB.prepare(
      `UPDATE reservable_areas SET name = ?, description = ?, color = ?, capacity = ?,
              active = ?, terms_text = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?`
    ).bind(area.name, area.description, area.color, area.capacity, area.active ? 1 : 0, area.termsText, areaId),
    env.DB.prepare(
      `UPDATE area_reservation_rules SET min_notice_minutes = ?, max_advance_days = ?,
              max_reservations_per_unit_month = ?, cancellation_cutoff_minutes = ?,
              max_guests = ?, fee_cents = ?, deposit_cents = ?, requires_approval = ?,
              allow_sundays = ?, allow_holidays = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE area_id = ?`
    ).bind(area.minNoticeMinutes, area.maxAdvanceDays, area.monthlyLimit,
      area.cancellationCutoffMinutes, area.maxGuests, area.feeCents, area.depositCents,
      area.requiresApproval ? 1 : 0, area.allowSundays ? 1 : 0, area.allowHolidays ? 1 : 0, areaId),
    ...existingSlots.results.filter((slot) => !incomingIds.has(slot.id)).map((slot) => env.DB.prepare(
      "UPDATE area_time_slots SET active = 0 WHERE id = ? AND area_id = ?"
    ).bind(slot.id, areaId)),
  ];
  for (const slot of area.slots) {
    if (knownIds.has(slot.id)) {
      statements.push(env.DB.prepare(
        `UPDATE area_time_slots SET name = ?, day_of_week = ?, starts_at = ?, ends_at = ?,
                active = ?, display_order = ? WHERE id = ? AND area_id = ?`
      ).bind(slot.name, slot.dayOfWeek, slot.startsAt, slot.endsAt, slot.active ? 1 : 0,
        slot.displayOrder, slot.id, areaId));
    } else {
      statements.push(env.DB.prepare(
        `INSERT INTO area_time_slots
          (id, area_id, name, day_of_week, starts_at, ends_at, active, display_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(slot.id, areaId, slot.name, slot.dayOfWeek, slot.startsAt, slot.endsAt,
        slot.active ? 1 : 0, slot.displayOrder));
    }
  }
  statements.push(env.DB.prepare(
    `INSERT INTO audit_events (id, actor_person_id, action, target_type, target_id)
     VALUES (?, ?, 'reservable_area.updated', 'reservable_area', ?)`
  ).bind(crypto.randomUUID(), context.person.id, areaId));
  await env.DB.batch(statements);
  return json({ ok: true });
}

async function listUnits(request, env) {
  const context = await authorizationContext(request, env, "reservations.manage");
  if (context.error) return context.error;
  const [units, occupants] = await Promise.all([
    env.DB.prepare(
      `SELECT id, number, active, reservations_enabled, reservation_block_reason
         FROM units ORDER BY CAST(number AS INTEGER), number`
    ).all(),
    env.DB.prepare(
      `SELECT o.unit_id, o.person_id, o.occupancy_type, p.first_name, p.last_name, p.email
         FROM occupancies o JOIN people p ON p.id = o.person_id
        WHERE o.starts_on <= ? AND (o.ends_on IS NULL OR o.ends_on >= ?)
        ORDER BY p.last_name, p.first_name`
    ).bind(costaRicaDate(), costaRicaDate()).all(),
  ]);
  return json({ units: units.results.map((unit) => ({
    ...unit,
    occupants: occupants.results.filter((occupant) => occupant.unit_id === unit.id),
  })) });
}

async function listHousingUnits(request, env) {
  const context = await authorizationContext(request, env, "people.read");
  if (context.error) return context.error;
  const units = await env.DB.prepare(
    "SELECT id, number FROM units WHERE active = 1 ORDER BY CAST(number AS INTEGER), number"
  ).all();
  return json({ units: units.results });
}

async function updateUnitReservationAccess(request, env, unitId) {
  const context = await authorizationContext(request, env, "reservations.manage");
  if (context.error) return context.error;
  const body = await request.json().catch(() => null);
  if (typeof body?.enabled !== "boolean") return json({ error: "invalid_unit_access" }, 400);
  const unit = await env.DB.prepare("SELECT id FROM units WHERE id = ?").bind(unitId).first();
  if (!unit) return json({ error: "unit_not_found" }, 404);
  const reason = body.enabled ? null : String(body.reason || "").trim().slice(0, 300);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE units SET reservations_enabled = ?, reservation_block_reason = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
    ).bind(body.enabled ? 1 : 0, reason, unitId),
    env.DB.prepare(
      `INSERT INTO audit_events (id, actor_person_id, action, target_type, target_id, details_json)
       VALUES (?, ?, 'unit.reservation_access_changed', 'unit', ?, ?)`
    ).bind(crypto.randomUUID(), context.person.id, unitId, JSON.stringify({ enabled: body.enabled, reason })),
  ]);
  return json({ ok: true });
}

async function getPersonHousing(request, env, personId) {
  const context = await authorizationContext(request, env, "people.manage");
  if (context.error) return context.error;
  const person = await env.DB.prepare("SELECT id FROM people WHERE id = ?").bind(personId).first();
  if (!person) return json({ error: "person_not_found" }, 404);
  const [units, ownerships, occupancies] = await Promise.all([
    env.DB.prepare("SELECT id, number FROM units WHERE active = 1 ORDER BY CAST(number AS INTEGER), number").all(),
    env.DB.prepare("SELECT unit_id, ownership_share, starts_on, ends_on FROM ownerships WHERE person_id = ?").bind(personId).all(),
    env.DB.prepare("SELECT unit_id, occupancy_type, starts_on, ends_on FROM occupancies WHERE person_id = ?").bind(personId).all(),
  ]);
  return json({ units: units.results, ownerships: ownerships.results, occupancies: occupancies.results });
}

async function updatePersonHousing(request, env, personId) {
  const context = await authorizationContext(request, env, "people.manage");
  if (context.error) return context.error;
  const person = await env.DB.prepare("SELECT id FROM people WHERE id = ?").bind(personId).first();
  if (!person) return json({ error: "person_not_found" }, 404);
  const body = await request.json().catch(() => null);
  const ownerships = Array.isArray(body?.ownerships) ? body.ownerships : [];
  const occupancies = Array.isArray(body?.occupancies) ? body.occupancies : [];
  const allowedOccupancyTypes = new Set(['owner_resident', 'tenant', 'authorized_occupant']);
  const validOptionalDate = (value) => value == null || value === "" || isIsoDate(value);
  const validRange = (startsOn, endsOn) => !startsOn || !endsOn || endsOn >= startsOn;
  const ownershipUnitIds = ownerships.map((item) => String(item.unitId || ""));
  const occupancyUnitIds = occupancies.map((item) => String(item.unitId || ""));
  const hasDuplicateUnits = new Set(ownershipUnitIds).size !== ownershipUnitIds.length
    || new Set(occupancyUnitIds).size !== occupancyUnitIds.length;
  if (hasDuplicateUnits
      || ownerships.some((item) => !item.unitId || !validOptionalDate(item.startsOn)
        || !validOptionalDate(item.endsOn) || !validRange(item.startsOn, item.endsOn)
        || item.ownershipShare != null && (!Number.isFinite(Number(item.ownershipShare))
          || Number(item.ownershipShare) <= 0 || Number(item.ownershipShare) > 1))
      || occupancies.some((item) => !item.unitId || !allowedOccupancyTypes.has(item.occupancyType)
        || !isIsoDate(item.startsOn) || !validOptionalDate(item.endsOn)
        || !validRange(item.startsOn, item.endsOn))) {
    return json({ error: "invalid_housing" }, 400);
  }
  const unitIds = [...new Set([...ownerships.map((item) => String(item.unitId)), ...occupancies.map((item) => String(item.unitId))])];
  if (unitIds.length) {
    const placeholders = unitIds.map(() => "?").join(",");
    const validUnits = await env.DB.prepare(`SELECT id FROM units WHERE id IN (${placeholders})`).bind(...unitIds).all();
    if (validUnits.results.length !== unitIds.length) return json({ error: "invalid_housing" }, 400);
  }
  const statements = [
    env.DB.prepare("DELETE FROM ownerships WHERE person_id = ?").bind(personId),
    env.DB.prepare("DELETE FROM occupancies WHERE person_id = ?").bind(personId),
    ...ownerships.map((item) => env.DB.prepare(
      `INSERT INTO ownerships (id, person_id, unit_id, ownership_share, starts_on, ends_on)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), personId, String(item.unitId), item.ownershipShare ?? null,
      item.startsOn || null, item.endsOn || null)),
    ...occupancies.map((item) => env.DB.prepare(
      `INSERT INTO occupancies (id, person_id, unit_id, occupancy_type, starts_on, ends_on, verified_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), personId, String(item.unitId), item.occupancyType,
      item.startsOn, item.endsOn || null, context.person.id)),
    env.DB.prepare(
      `INSERT INTO audit_events (id, actor_person_id, action, target_type, target_id, details_json)
       VALUES (?, ?, 'person.housing_replaced', 'person', ?, ?)`
    ).bind(crypto.randomUUID(), context.person.id, personId, JSON.stringify({ ownerships, occupancies })),
  ];
  await env.DB.batch(statements);
  return json({ ok: true });
}

async function protectDocument(request, env) {
  const context = await authorizationContext(request, env, "documents.read");
  if (context.error) return context.error;
  return env.ASSETS.fetch(request);
}

async function handleApi(request, env, url) {
  if (url.pathname === "/api/me" && request.method === "GET") return handleMe(request, env);
  if (url.pathname === "/api/bootstrap" && request.method === "POST") return handleBootstrap(request, env);
  if (url.pathname === "/api/admin/roles" && request.method === "GET") return handleRoles(request, env);
  if (url.pathname === "/api/admin/people" && request.method === "GET") return listPeople(request, env);
  if (url.pathname === "/api/admin/people" && request.method === "POST") return createPerson(request, env);
  if (url.pathname === "/api/reservations/calendar" && request.method === "GET") return handleReservationCalendar(request, env, url);
  if (url.pathname === "/api/reservations/eligibility" && request.method === "GET") return handleReservationEligibility(request, env, url);
  if (url.pathname === "/api/reservations" && request.method === "POST") return createReservation(request, env);
  if (url.pathname === "/api/visitors/mine" && request.method === "GET") return listOwnVisitors(request, env);
  if (url.pathname === "/api/visitors" && request.method === "POST") return createVisitorAuthorization(request, env);
  if (url.pathname === "/api/security/visits" && request.method === "GET") return listSecurityVisits(request, env, url);
  if (url.pathname === "/api/security/reservations" && request.method === "GET") return listSecurityReservations(request, env, url);
  if (url.pathname === "/api/security/incidents" && request.method === "GET") return listSecurityIncidents(request, env, url);
  if (url.pathname === "/api/security/incidents" && request.method === "POST") return createSecurityIncident(request, env);
  if (url.pathname === "/api/admin/reservable-areas" && request.method === "GET") return listReservableAreas(request, env);
  if (url.pathname === "/api/admin/reservable-areas" && request.method === "POST") return createReservableArea(request, env);
  if (url.pathname === "/api/admin/units" && request.method === "GET") return listUnits(request, env);
  if (url.pathname === "/api/admin/housing-units" && request.method === "GET") return listHousingUnits(request, env);

  const rolesMatch = url.pathname.match(/^\/api\/admin\/people\/([^/]+)\/roles$/);
  if (rolesMatch && request.method === "PUT") return replaceRoles(request, env, rolesMatch[1]);

  const statusMatch = url.pathname.match(/^\/api\/admin\/people\/([^/]+)\/status$/);
  if (statusMatch && request.method === "PATCH") return updateStatus(request, env, statusMatch[1]);

  const housingMatch = url.pathname.match(/^\/api\/admin\/people\/([^/]+)\/housing$/);
  if (housingMatch && request.method === "GET") return getPersonHousing(request, env, housingMatch[1]);
  if (housingMatch && request.method === "PUT") return updatePersonHousing(request, env, housingMatch[1]);

  const areaMatch = url.pathname.match(/^\/api\/admin\/reservable-areas\/([^/]+)$/);
  if (areaMatch && request.method === "PUT") return updateReservableArea(request, env, areaMatch[1]);

  const unitAccessMatch = url.pathname.match(/^\/api\/admin\/units\/([^/]+)\/reservation-access$/);
  if (unitAccessMatch && request.method === "PATCH") return updateUnitReservationAccess(request, env, unitAccessMatch[1]);

  const cancelMatch = url.pathname.match(/^\/api\/reservations\/([^/]+)\/cancel$/);
  if (cancelMatch && request.method === "PATCH") return cancelReservation(request, env, cancelMatch[1]);

  const visitorCancelMatch = url.pathname.match(/^\/api\/visitors\/([^/]+)\/cancel$/);
  if (visitorCancelMatch && request.method === "PATCH") return cancelVisitorAuthorization(request, env, visitorCancelMatch[1]);

  const visitorOutcomeMatch = url.pathname.match(/^\/api\/security\/visits\/([^/]+)\/outcome$/);
  if (visitorOutcomeMatch && request.method === "POST") return recordVisitorOutcome(request, env, visitorOutcomeMatch[1]);

  const reservationReleaseMatch = url.pathname.match(/^\/api\/security\/reservations\/([^/]+)\/release$/);
  if (reservationReleaseMatch && request.method === "POST") return releaseReservationForUse(request, env, reservationReleaseMatch[1]);

  const reservationStatusMatch = url.pathname.match(/^\/api\/admin\/reservations\/([^/]+)\/status$/);
  if (reservationStatusMatch && request.method === "PATCH") return updateReservationStatus(request, env, reservationStatusMatch[1]);

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/clerk-bootstrap.js") return handleClerkBootstrap(request, env);
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url);
      if (url.pathname.startsWith("/documents/")) return await protectDocument(request, env);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ error: "internal_error" }, 500);
    }
  },
};
