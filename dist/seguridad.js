const securityModule = document.querySelector("#security-module");
const calendarMonth = document.querySelector("#security-calendar-month");
const calendarGrid = document.querySelector("#security-calendar-grid");
const selectedDayTitle = document.querySelector("#security-selected-day");
const unitFilter = document.querySelector("#security-unit-filter");
const visitsList = document.querySelector("#security-visits-list");
const reservationsList = document.querySelector("#security-reservations-list");
const incidentFilterDate = document.querySelector("#incident-filter-date");
const incidentForm = document.querySelector("#incident-form");
const incidentList = document.querySelector("#incident-list");
const today = costaRicaDate();
let selectedDate = today;
let viewMonth = new Date(`${today.slice(0, 7)}-01T12:00:00`);
let monthData = { units: [], visits: [], reservations: [] };
let profile = null;

function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
function costaRicaDate(date = new Date()) { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date); const value = Object.fromEntries(parts.map((part) => [part.type, part.value])); return `${value.year}-${value.month}-${value.day}`; }
function localDate(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function localDateTimeInput(date = new Date()) { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date); const value = Object.fromEntries(parts.map((part) => [part.type, part.value])); return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`; }
function formatDateTime(value) { return new Intl.DateTimeFormat("es-CR", { timeZone: "America/Costa_Rica", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function formatTime(value) { return new Intl.DateTimeFormat("es-CR", { timeZone: "America/Costa_Rica", hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
async function api(path, options = {}) { const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", Accept: "application/json", ...options.headers } }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(({ visit_outcome_already_recorded: "Esta visita ya tiene un resultado registrado.", invalid_security_incident: "Incluye la fecha, hora y descripción.", reservation_not_confirmed: "La reserva todavía no está confirmada.", reservation_release_wrong_day: "La entrega solo se registra el día de la reserva.", incomplete_release_checklist: "Completa todos los puntos antes de habilitar el área.", reservation_already_released: "Esta reserva ya fue habilitada." })[payload.error] || "No pudimos completar la acción."); return payload; }
const visitorTypes = { guest: "Invitado", delivery: "Entrega", domestic_worker: "Servicio doméstico", service: "Servicio técnico", contractor: "Contratista", transport: "Transporte", other: "Otro" };
const outcomes = { allowed_resident_authorized: "Ingreso autorizado por residente", allowed_administration_authorized: "Ingreso autorizado por administración", denied_resident: "Ingreso rechazado por residente", denied_documents: "Ingreso rechazado por falta de documentos", denied_protocol: "Ingreso rechazado por incumplir protocolo", cancelled_by_visitor: "Visita cancelada", no_show: "No se presentó" };

function monthRange() { const first = localDate(new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1, 12)); const last = localDate(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0, 12)); return { first, last }; }
function filteredVisits() { const unitId = unitFilter.value; return monthData.visits.filter((visit) => unitId === "all" || visit.unit_id === unitId); }
function filteredReservations() { const unitId = unitFilter.value; return monthData.reservations.filter((reservation) => unitId === "all" || reservation.unit_id === unitId); }
function renderCalendar() { const label = new Intl.DateTimeFormat("es-CR", { month: "long", year: "numeric" }).format(viewMonth); calendarMonth.textContent = label.charAt(0).toUpperCase() + label.slice(1); const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1, 12); const start = new Date(first); start.setDate(first.getDate() - first.getDay()); const visits = filteredVisits(); const reservations = filteredReservations(); const cells = []; for (let index = 0; index < 42; index += 1) { const date = new Date(start); date.setDate(start.getDate() + index); const iso = localDate(date); const inMonth = date.getMonth() === viewMonth.getMonth(); const visitCount = visits.filter((visit) => visit.date === iso).length; const reservationCount = reservations.filter((reservation) => reservation.reservation_date === iso).length; cells.push(`<button type="button" role="gridcell" class="calendar-day ${inMonth ? "" : "outside"} ${iso === today ? "today" : ""} ${iso === selectedDate ? "selected" : ""}" data-security-date="${iso}"><span class="calendar-number">${date.getDate()}</span><span class="security-day-flags">${visitCount ? `<span class="security-visit-count">${visitCount} visita${visitCount === 1 ? "" : "s"}</span>` : ""}${reservationCount ? `<span class="security-reservation-count">${reservationCount} reserva${reservationCount === 1 ? "" : "s"}</span>` : ""}</span></button>`); } calendarGrid.innerHTML = cells.join(""); renderSelectedDay(); }
function renderSelectedDay() {
  const date = new Date(`${selectedDate}T12:00:00`);
  const visits = filteredVisits().filter((visit) => visit.date === selectedDate);
  const dateLabel = new Intl.DateTimeFormat("es-CR", { weekday: "long", day: "numeric", month: "long" }).format(date);
  const reservations = filteredReservations().filter((reservation) => reservation.reservation_date === selectedDate);
  selectedDayTitle.innerHTML = `${escapeHtml(dateLabel)} <span>${visits.length} visita${visits.length === 1 ? "" : "s"}</span> <span class="reservation-total">${reservations.length} reserva${reservations.length === 1 ? "" : "s"}</span>`;
  visitsList.innerHTML = visits.length ? visits.map((visit) => `<article class="expected-visit-card compact ${visit.event ? "resolved" : ""}">
    <div class="visit-time"><strong>${escapeHtml(formatTime(visit.scheduledFor))}</strong><span>Vivienda ${escapeHtml(visit.unit_number)}</span></div>
    <div class="visit-summary"><span class="visitor-type">${escapeHtml(visitorTypes[visit.visitor_type] || visit.visitor_type)}</span><h3>${escapeHtml(visit.visitor_name)}</h3><p>${escapeHtml(visit.creator_first_name)} ${escapeHtml(visit.creator_last_name)}${visit.vehicle_plate ? ` · Placa ${escapeHtml(visit.vehicle_plate)}` : ""}</p>${visit.notes ? `<small>${escapeHtml(visit.notes)}</small>` : ""}</div>
    ${visit.event
      ? `<div class="visit-result"><strong>${escapeHtml(outcomes[visit.event.outcome])}</strong><span>${escapeHtml(formatDateTime(visit.event.recorded_at))}</span>${visit.event.notes ? `<p>${escapeHtml(visit.event.notes)}</p>` : ""}</div>`
      : `<button class="visit-expand" type="button" data-toggle-outcome aria-expanded="false">Registrar resultado</button>
         <div class="visit-actions" hidden><textarea rows="2" maxlength="800" placeholder="Nota opcional" data-outcome-notes></textarea><div class="outcome-buttons">${Object.entries(outcomes).map(([key, text]) => `<button type="button" data-record-outcome="${key}" data-authorization="${escapeHtml(visit.id)}" data-scheduled="${escapeHtml(visit.scheduledFor)}">${escapeHtml(text)}</button>`).join("")}</div></div>`}
  </article>`).join("") : '<p class="empty-day">No hay visitas esperadas para esta fecha y vivienda.</p>';
  renderReservations(reservations);
}
function renderReservations(reservations) {
  reservationsList.innerHTML = reservations.length ? reservations.map((reservation) => {
    const isSpa = reservation.area_id === "area-spa" || /spa/i.test(reservation.area_name);
    const released = Boolean(reservation.released_at);
    const canRelease = reservation.status === "confirmed" && reservation.reservation_date === today;
    return `<article class="security-reservation-card ${released ? "released" : ""}">
      <div class="reservation-area-mark" style="--area-color:${escapeHtml(reservation.area_color)}"></div>
      <div class="security-reservation-summary"><span>${escapeHtml(reservation.starts_at)}–${escapeHtml(reservation.ends_at)} · Vivienda ${escapeHtml(reservation.unit_number)}</span><h3>${escapeHtml(reservation.area_name)}</h3><p>${escapeHtml(reservation.resident_first_name)} ${escapeHtml(reservation.resident_last_name)} · ${reservation.guest_count} invitado${Number(reservation.guest_count) === 1 ? "" : "s"}${reservation.status === "pending" ? " · Pendiente de aprobación" : ""}</p></div>
      ${released ? `<div class="reservation-release-result"><strong>${reservation.release_type === "access_key" ? "Llave entregada" : "Área habilitada"}</strong><span>${escapeHtml(formatDateTime(reservation.released_at))}</span><small>${escapeHtml(reservation.released_by_first_name)} ${escapeHtml(reservation.released_by_last_name)}</small></div>`
        : `<div class="reservation-release-panel">
          ${isSpa ? '<p>Confirma la entrega de la llave o medio de acceso al responsable.</p>' : `<div class="release-checklist"><label><input type="checkbox" value="responsible_verified" /> Responsable y vivienda verificados</label><label><input type="checkbox" value="area_inspected" /> Área revisada junto al residente</label><label><input type="checkbox" value="rules_reviewed" /> Reglas de uso recordadas</label><label><input type="checkbox" value="schedule_confirmed" /> Horario de cierre confirmado</label></div>`}
          <textarea rows="2" maxlength="1000" placeholder="Observaciones opcionales" data-release-notes></textarea>
          <button type="button" class="primary-action" data-release-reservation="${escapeHtml(reservation.id)}" ${canRelease ? "" : "disabled"}>${reservation.status === "pending" ? "Pendiente de aprobación" : reservation.reservation_date !== today ? "Disponible el día de la reserva" : isSpa ? "Confirmar entrega de llave" : "Completar revisión y habilitar"}</button>
        </div>`}
    </article>`;
  }).join("") : '<p class="empty-day">No hay reservas para esta fecha y vivienda.</p>';
}
async function loadMonth() { const { first, last } = monthRange(); visitsList.innerHTML = '<p class="empty-day">Cargando visitas…</p>'; reservationsList.innerHTML = '<p class="empty-day">Cargando reservas…</p>'; const [visitsPayload, reservationsPayload] = await Promise.all([api(`/api/security/visits?from=${first}&to=${last}`), api(`/api/security/reservations?from=${first}&to=${last}`)]); monthData = { units: visitsPayload.units, visits: visitsPayload.visits, reservations: reservationsPayload.reservations }; const current = unitFilter.value; unitFilter.innerHTML = '<option value="all">Todas las viviendas</option>' + monthData.units.map((unit) => `<option value="${escapeHtml(unit.id)}">Vivienda ${escapeHtml(unit.number)}</option>`).join(""); if ([...unitFilter.options].some((option) => option.value === current)) unitFilter.value = current; renderCalendar(); }
async function loadIncidents() { if (!profile?.permissions.includes("security.incidents.read")) return; const payload = await api(`/api/security/incidents?from=${incidentFilterDate.value}&to=${incidentFilterDate.value}`); incidentList.innerHTML = payload.incidents.length ? payload.incidents.map((incident) => `<article class="incident-entry"><time>${escapeHtml(formatDateTime(incident.occurred_at))}</time><p>${escapeHtml(incident.description)}</p><small>Registrado por ${escapeHtml(incident.creator_first_name)} ${escapeHtml(incident.creator_last_name)}</small></article>`).join("") : '<p class="empty-day">No hay incidentes registrados para esta fecha.</p>'; }
calendarGrid.addEventListener("click", (event) => { const button = event.target.closest("[data-security-date]"); if (!button) return; selectedDate = button.dataset.securityDate; const date = new Date(`${selectedDate}T12:00:00`); if (date.getMonth() !== viewMonth.getMonth()) { viewMonth = new Date(date.getFullYear(), date.getMonth(), 1, 12); loadMonth(); } else renderCalendar(); });
unitFilter.addEventListener("change", renderCalendar);
document.querySelector("#security-previous-month").addEventListener("click", () => { viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1, 12); selectedDate = localDate(viewMonth); loadMonth(); });
document.querySelector("#security-next-month").addEventListener("click", () => { viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1, 12); selectedDate = localDate(viewMonth); loadMonth(); });
document.querySelector("#security-today").addEventListener("click", () => { selectedDate = today; viewMonth = new Date(`${today.slice(0, 7)}-01T12:00:00`); loadMonth(); });
visitsList.addEventListener("click", async (event) => {
  const toggle = event.target.closest("[data-toggle-outcome]");
  if (toggle) {
    const card = toggle.closest(".expected-visit-card");
    const panel = card.querySelector(".visit-actions");
    const willOpen = panel.hidden;
    visitsList.querySelectorAll(".visit-actions").forEach((item) => { item.hidden = true; });
    visitsList.querySelectorAll("[data-toggle-outcome]").forEach((item) => { item.setAttribute("aria-expanded", "false"); item.textContent = "Registrar resultado"; });
    panel.hidden = !willOpen;
    toggle.setAttribute("aria-expanded", String(willOpen));
    toggle.textContent = willOpen ? "Cerrar" : "Registrar resultado";
    if (willOpen) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  const button = event.target.closest("[data-record-outcome]");
  if (!button) return;
  const card = button.closest(".expected-visit-card");
  const notes = card.querySelector("[data-outcome-notes]").value;
  card.querySelectorAll("button").forEach((item) => { item.disabled = true; });
  try { await api(`/api/security/visits/${button.dataset.authorization}/outcome`, { method: "POST", body: JSON.stringify({ scheduledFor: button.dataset.scheduled, outcome: button.dataset.recordOutcome, notes }) }); await loadMonth(); }
  catch (error) { card.querySelectorAll("button").forEach((item) => { item.disabled = false; }); window.alert(error.message); }
});
reservationsList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-release-reservation]");
  if (!button) return;
  const card = button.closest(".security-reservation-card");
  const checklist = [...card.querySelectorAll('.release-checklist input:checked')].map((input) => input.value);
  const notes = card.querySelector("[data-release-notes]").value;
  button.disabled = true;
  button.textContent = "Registrando…";
  try {
    await api(`/api/security/reservations/${button.dataset.releaseReservation}/release`, {
      method: "POST",
      body: JSON.stringify({ checklist, notes }),
    });
    await loadMonth();
  } catch (error) {
    button.disabled = false;
    button.textContent = card.querySelector(".release-checklist")
      ? "Completar revisión y habilitar"
      : "Confirmar entrega de llave";
    window.alert(error.message);
  }
});
incidentFilterDate.addEventListener("change", loadIncidents);
incidentForm.addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(incidentForm); const feedback = document.querySelector("#incident-feedback"); feedback.textContent = "Registrando…"; try { await api("/api/security/incidents", { method: "POST", body: JSON.stringify({ occurredAt: form.get("occurredAt"), description: form.get("description") }) }); incidentForm.elements.description.value = ""; incidentFilterDate.value = form.get("occurredAt").slice(0, 10); feedback.textContent = "Incidente registrado."; await loadIncidents(); } catch (error) { feedback.textContent = error.message; } });
document.addEventListener("naia:authorization", async (event) => { profile = event.detail.profile; if (!profile) return; if (!profile.permissions.includes("visitors.read")) { document.querySelector("#portal-shell").hidden = true; document.querySelector("#auth-gate").hidden = false; document.querySelector("#auth-loading").hidden = true; document.querySelector("#clerk-sign-in").hidden = true; const error = document.querySelector("#auth-error"); error.hidden = false; error.querySelector("strong").textContent = "Acceso operativo restringido"; error.querySelector("p").textContent = "Este módulo está disponible únicamente para seguridad y administración."; return; } securityModule.hidden = false; incidentFilterDate.value = today; incidentForm.elements.occurredAt.value = localDateTimeInput(); await Promise.all([loadMonth(), loadIncidents()]); });
