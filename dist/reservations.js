const reservationAlert = document.querySelector("#reservation-alert");
const reservationWorkspace = document.querySelector("#reservation-workspace");
const calendarMonth = document.querySelector("#calendar-month");
const calendarGrid = document.querySelector("#calendar-grid");
const areaFilter = document.querySelector("#area-filter");
const selectedDayTitle = document.querySelector("#selected-day-title");
const eligibilityNote = document.querySelector("#eligibility-note");
const daySlots = document.querySelector("#day-slots");
const reservationDialog = document.querySelector("#reservation-dialog");
const reservationForm = document.querySelector("#reservation-form");
const areaDialog = document.querySelector("#area-dialog");
const areaForm = document.querySelector("#area-form");
const slotEditorList = document.querySelector("#slot-editor-list");
const reservationAdmin = document.querySelector("#reservation-admin");
const areasAdminPanel = document.querySelector("#areas-admin-panel");
const unitsAdminPanel = document.querySelector("#units-admin-panel");
const unitsAdminList = document.querySelector("#units-admin-list");

const today = costaRicaDate();
let profile = null;
let viewMonth = new Date(`${today.slice(0, 7)}-01T12:00:00`);
let selectedDate = today;
let selectedArea = "all";
let calendarData = { areas: [], slots: [], reservations: [], holidays: [], canSeeDetails: false };
let eligibility = { units: [], activeReservations: [], canCreate: false };
let adminAreas = [];
let units = [];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function localDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

function dateFromIso(value) {
  return new Date(`${value}T12:00:00`);
}

function errorMessage(code, payload = {}) {
  return ({
    slot_unavailable: "Ese bloque acaba de ser reservado. Elige otro.",
    unit_reservations_suspended: payload.reason || "La vivienda tiene suspendido el acceso a reservaciones.",
    not_current_resident: "No tienes una residencia activa para esa fecha.",
    notice_period: "Este bloque ya no cumple con la anticipación mínima.",
    advance_limit: "La fecha supera la anticipación máxima permitida.",
    guest_limit: "La cantidad de invitados supera el máximo permitido.",
    monthly_limit: "La vivienda alcanzó el límite mensual para esta área.",
    unit_area_active_reservation: "La vivienda ya tiene una reserva activa en esta área.",
    sunday_not_reservable: "Los domingos no están habilitados para reservaciones.",
    holiday_not_reservable: payload.holiday
      ? `${payload.holiday} no está habilitado para reservaciones.`
      : "Los feriados no están habilitados para reservaciones.",
    cancellation_cutoff: "El plazo para cancelar esta reserva ya venció.",
    security_read_only: "La función de seguridad tiene acceso de consulta únicamente.",
    invalid_area: "Revisa la información y los bloques del área.",
  })[code] || "No pudimos completar la acción.";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", Accept: "application/json", ...options.headers },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(errorMessage(payload.error, payload)), { code: payload.error, payload });
  return payload;
}

function monthRange() {
  const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1, 12);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const end = new Date(start);
  end.setDate(start.getDate() + 41);
  return { from: localDate(start), to: localDate(end), start, end };
}

function areaFor(id) {
  return calendarData.areas.find((area) => area.id === id);
}

function applicableSlots(areaId, date) {
  const day = dateFromIso(date).getDay();
  return calendarData.slots.filter((slot) => slot.area_id === areaId
    && (slot.day_of_week === null || Number(slot.day_of_week) === day));
}

function reservationFor(date, areaId, slotId) {
  return calendarData.reservations.find((reservation) => reservation.reservation_date === date
    && reservation.area_id === areaId && reservation.slot_id === slotId);
}

function bookingWindow(area, slot, date) {
  if (dateFromIso(date).getDay() === 0 && !area.allow_sundays) {
    return { open: false, label: "Domingo no reservable" };
  }
  const holiday = (calendarData.holidays || []).find((entry) => entry.date === date);
  if (holiday && !area.allow_holidays) {
    return { open: false, label: `Feriado no reservable · ${holiday.name}` };
  }
  const startsAt = new Date(`${date}T${slot.starts_at}:00-06:00`).getTime();
  const endsAt = new Date(`${date}T${slot.ends_at}:00-06:00`).getTime();
  const now = Date.now();
  if (now >= endsAt) return { open: false, label: "Finalizado" };
  if (now >= startsAt) return { open: false, label: "En curso" };
  const noticeOpensAt = startsAt - Number(area.min_notice_minutes || 0) * 60000;
  if (now > noticeOpensAt) return { open: false, label: "Fuera del plazo de reserva" };
  return { open: true, label: "Disponible" };
}

function unitsAvailableForArea(areaId) {
  const activeReservations = eligibility.activeReservations || [];
  return eligibility.units.filter((unit) => unit.reservations_enabled
    && !activeReservations.some((reservation) => reservation.unit_id === unit.id
      && reservation.area_id === areaId));
}

function renderFilters() {
  areaFilter.innerHTML = [
    `<button type="button" class="${selectedArea === "all" ? "active" : ""}" data-area-filter="all">Todas</button>`,
    ...calendarData.areas.map((area) => `<button type="button" class="${selectedArea === area.id ? "active" : ""}" data-area-filter="${escapeHtml(area.id)}"><span style="--area-color:${escapeHtml(area.color)}"></span>${escapeHtml(area.name)}</button>`),
  ].join("");
}

function renderCalendar() {
  const formatter = new Intl.DateTimeFormat("es-CR", { month: "long", year: "numeric" });
  const monthLabel = formatter.format(viewMonth);
  calendarMonth.textContent = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);
  const { start } = monthRange();
  const cells = [];
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const iso = localDate(date);
    const inMonth = date.getMonth() === viewMonth.getMonth();
    const dayReservations = calendarData.reservations.filter((reservation) => reservation.reservation_date === iso
      && (selectedArea === "all" || reservation.area_id === selectedArea));
    cells.push(`<button type="button" role="gridcell" class="calendar-day ${inMonth ? "" : "outside"} ${iso === today ? "today" : ""} ${iso === selectedDate ? "selected" : ""}" data-calendar-date="${iso}">
      <span class="calendar-number">${date.getDate()}</span>
      <span class="reservation-dots">${dayReservations.slice(0, 4).map((reservation) => {
        const area = areaFor(reservation.area_id);
        return `<i style="--area-color:${escapeHtml(area?.color || "#A84132")}" title="${escapeHtml(area?.name || "Reserva")}"></i>`;
      }).join("")}</span>
      ${dayReservations.length ? `<small>${dayReservations.length} reserva${dayReservations.length === 1 ? "" : "s"}</small>` : ""}
    </button>`);
  }
  calendarGrid.innerHTML = cells.join("");
}

async function loadEligibility() {
  eligibility = await api(`/api/reservations/eligibility?date=${selectedDate}`);
}

function renderSelectedDay() {
  const dayLabel = new Intl.DateTimeFormat("es-CR", { weekday: "long", day: "numeric", month: "long" }).format(dateFromIso(selectedDate));
  selectedDayTitle.textContent = dayLabel.charAt(0).toUpperCase() + dayLabel.slice(1);
  const securityReadOnly = profile?.roles?.includes("security") && !profile?.roles?.includes("administrator");
  const enabledUnits = securityReadOnly ? [] : eligibility.units.filter((unit) => unit.reservations_enabled);
  if (enabledUnits.length) {
    eligibilityNote.textContent = `Puedes reservar a nombre de la vivienda ${enabledUnits.map((unit) => unit.number).join(", ")}.`;
  } else if (eligibility.units.length) {
    eligibilityNote.textContent = eligibility.units[0].reservation_block_reason || "La vivienda tiene suspendido temporalmente el acceso a reservaciones.";
  } else {
    eligibilityNote.textContent = securityReadOnly
      ? "Acceso de seguridad: consulta únicamente."
      : "No tienes una ocupación residencial activa para esta fecha.";
  }

  const areas = calendarData.areas.filter((area) => selectedArea === "all" || area.id === selectedArea);
  daySlots.innerHTML = areas.map((area) => {
    const slots = applicableSlots(area.id, selectedDate);
    if (!slots.length) return "";
    return `<section class="day-area"><div class="day-area-heading"><span style="--area-color:${escapeHtml(area.color)}"></span><div><h3>${escapeHtml(area.name)}</h3><p>${escapeHtml(area.description)}</p></div></div>
      <div class="slot-list">${slots.map((slot) => {
        const reservation = reservationFor(selectedDate, area.id, slot.id);
        if (reservation) {
          const detail = (calendarData.canSeeDetails || reservation.is_household) && reservation.unit_number
            ? `Vivienda ${escapeHtml(reservation.unit_number)} · ${escapeHtml(reservation.first_name)} ${escapeHtml(reservation.last_name)}`
            : "Reservado";
          const managesReservations = profile.permissions.includes("reservations.manage");
          const actions = reservation.status === "pending" && managesReservations
            ? `<span class="slot-actions"><button type="button" data-reservation-status="confirmed" data-reservation-id="${escapeHtml(reservation.id)}">Aprobar</button><button type="button" class="secondary" data-reservation-status="rejected" data-reservation-id="${escapeHtml(reservation.id)}">Rechazar</button></span>`
            : reservation.is_household || managesReservations
              ? `<button type="button" data-cancel-reservation="${escapeHtml(reservation.id)}">Cancelar</button>`
              : "";
          return `<article class="slot-row reserved"><div><strong>${escapeHtml(slot.name)}</strong><span>${slot.starts_at}–${slot.ends_at}</span></div><p>${detail}${reservation.status === "pending" ? " · Pendiente" : ""}</p>${actions}</article>`;
        }
        const windowStatus = bookingWindow(area, slot, selectedDate);
        const areaUnits = unitsAvailableForArea(area.id);
        const areaLimitReached = enabledUnits.length > 0 && areaUnits.length === 0;
        const canReserve = areaUnits.length > 0 && windowStatus.open;
        const label = windowStatus.open && areaLimitReached
          ? "La vivienda ya tiene una reserva activa en esta área"
          : windowStatus.label;
        return `<article class="slot-row ${canReserve ? "available" : "closed"}"><div><strong>${escapeHtml(slot.name)}</strong><span>${slot.starts_at}–${slot.ends_at}</span></div><p>${escapeHtml(label)}</p>${canReserve ? `<button type="button" data-reserve-area="${escapeHtml(area.id)}" data-reserve-slot="${escapeHtml(slot.id)}">Reservar</button>` : ""}</article>`;
      }).join("")}</div></section>`;
  }).join("") || `<div class="empty-day">No hay bloques configurados para este día.</div>`;
}

async function loadCalendar() {
  const { from, to } = monthRange();
  reservationAlert.hidden = false;
  try {
    [calendarData] = await Promise.all([
      api(`/api/reservations/calendar?from=${from}&to=${to}`),
      loadEligibility(),
    ]);
    renderFilters();
    renderCalendar();
    renderSelectedDay();
    reservationWorkspace.hidden = false;
    reservationAlert.hidden = true;
  } catch (error) {
    reservationAlert.innerHTML = `<strong>No se pudo cargar el calendario.</strong><p>${escapeHtml(error.message)}</p>`;
  }
}

function openReservation(areaId, slotId) {
  const area = areaFor(areaId);
  const slot = calendarData.slots.find((entry) => entry.id === slotId);
  reservationForm.reset();
  reservationForm.elements.areaId.value = areaId;
  reservationForm.elements.slotId.value = slotId;
  reservationForm.elements.date.value = selectedDate;
  document.querySelector("#reservation-dialog-title").textContent = `${area.name} · ${slot.name}`;
  document.querySelector("#reservation-unit").innerHTML = unitsAvailableForArea(areaId)
    .map((unit) => `<option value="${escapeHtml(unit.id)}">Vivienda ${escapeHtml(unit.number)}</option>`).join("");
  document.querySelector("#reservation-terms").innerHTML = `<strong>${slot.starts_at}–${slot.ends_at}</strong><p>${escapeHtml(area.terms_text || "Sigue las normas generales de convivencia y deja el área limpia y ordenada.")}</p>${area.fee_cents || area.deposit_cents ? `<small>Tarifa: ₡${Number(area.fee_cents / 100).toLocaleString("es-CR")} · Depósito: ₡${Number(area.deposit_cents / 100).toLocaleString("es-CR")}</small>` : ""}`;
  document.querySelector("#reservation-feedback").textContent = "";
  reservationDialog.showModal();
}

async function loadAdminData() {
  const [areasPayload, unitsPayload] = await Promise.all([
    api("/api/admin/reservable-areas"),
    api("/api/admin/units"),
  ]);
  adminAreas = areasPayload.areas;
  units = unitsPayload.units;
  renderAdminAreas();
  renderUnits();
}

function renderAdminAreas() {
  areasAdminPanel.innerHTML = adminAreas.map((area) => `<article class="area-admin-card"><div class="area-admin-title"><span style="--area-color:${escapeHtml(area.color)}"></span><div><h3>${escapeHtml(area.name)}</h3><p>${area.active ? "Activa" : "Inactiva"} · ${area.slots.filter((slot) => slot.active).length} bloque(s)</p></div></div><p>${escapeHtml(area.description)}</p><div class="area-rule-summary"><span>${area.min_notice_minutes / 60} h anticipación</span><span>${area.max_advance_days} días máximo</span>${area.max_reservations_per_unit_month ? `<span>${area.max_reservations_per_unit_month}/mes por vivienda</span>` : ""}<span>${area.allow_sundays ? "Domingos permitidos" : "Domingos bloqueados"}</span><span>${area.allow_holidays ? "Feriados permitidos" : "Feriados bloqueados"}</span></div><button class="secondary-action" type="button" data-edit-area="${escapeHtml(area.id)}">Editar reglas</button></article>`).join("");
}

function renderUnits(filter = "") {
  const needle = filter.trim().toLowerCase();
  unitsAdminList.innerHTML = units.filter((unit) => !needle || unit.number.includes(needle)
    || unit.occupants.some((occupant) => `${occupant.first_name} ${occupant.last_name} ${occupant.email}`.toLowerCase().includes(needle)))
    .map((unit) => `<article class="unit-access-row"><div><strong>Vivienda ${escapeHtml(unit.number)}</strong><p>${unit.occupants.length ? unit.occupants.map((occupant) => `${escapeHtml(occupant.first_name)} ${escapeHtml(occupant.last_name)}`).join(", ") : "Sin ocupantes registrados"}</p>${!unit.reservations_enabled && unit.reservation_block_reason ? `<small>${escapeHtml(unit.reservation_block_reason)}</small>` : ""}</div><button class="${unit.reservations_enabled ? "danger-action" : "secondary-action"}" type="button" data-toggle-unit="${escapeHtml(unit.id)}">${unit.reservations_enabled ? "Suspender reservas" : "Reactivar reservas"}</button></article>`).join("");
}

function slotEditorRow(slot = {}) {
  return `<div class="slot-editor-row"><input type="hidden" data-slot-field="id" value="${escapeHtml(slot.id || "")}" /><label><span>Nombre</span><input data-slot-field="name" value="${escapeHtml(slot.name || "")}" placeholder="Mañana" required /></label><label><span>Inicio</span><input data-slot-field="startsAt" type="time" value="${escapeHtml(slot.starts_at || slot.startsAt || "09:00")}" required /></label><label><span>Fin</span><input data-slot-field="endsAt" type="time" value="${escapeHtml(slot.ends_at || slot.endsAt || "10:00")}" required /></label><label><span>Día</span><select data-slot-field="dayOfWeek"><option value="">Todos</option>${["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"].map((day, index) => `<option value="${index}" ${Number(slot.day_of_week ?? slot.dayOfWeek) === index ? "selected" : ""}>${day}</option>`).join("")}</select></label><label class="toggle-field"><input data-slot-field="active" type="checkbox" ${slot.active === 0 || slot.active === false ? "" : "checked"} /><span>Activo</span></label><button class="slot-remove" type="button" aria-label="Quitar bloque">×</button></div>`;
}

function openAreaDialog(area = null) {
  areaForm.reset();
  areaForm.elements.areaId.value = area?.id || "";
  areaForm.elements.name.value = area?.name || "";
  areaForm.elements.description.value = area?.description || "";
  areaForm.elements.color.value = area?.color || "#A84132";
  areaForm.elements.capacity.value = area?.capacity ?? "";
  areaForm.elements.maxGuests.value = area?.max_guests ?? "";
  areaForm.elements.minNoticeHours.value = area ? area.min_notice_minutes / 60 : 0;
  areaForm.elements.maxAdvanceDays.value = area?.max_advance_days ?? 365;
  areaForm.elements.monthlyLimit.value = area?.max_reservations_per_unit_month ?? "";
  areaForm.elements.cancellationHours.value = area ? area.cancellation_cutoff_minutes / 60 : 0;
  areaForm.elements.fee.value = area ? area.fee_cents / 100 : 0;
  areaForm.elements.deposit.value = area ? area.deposit_cents / 100 : 0;
  areaForm.elements.termsText.value = area?.terms_text || "";
  areaForm.elements.active.checked = area ? Boolean(area.active) : true;
  areaForm.elements.requiresApproval.checked = Boolean(area?.requires_approval);
  areaForm.elements.allowSundays.checked = Boolean(area?.allow_sundays);
  areaForm.elements.allowHolidays.checked = Boolean(area?.allow_holidays);
  slotEditorList.innerHTML = (area?.slots?.length ? area.slots : [{}]).map(slotEditorRow).join("");
  document.querySelector("#area-dialog-title").textContent = area ? `Editar ${area.name}` : "Nueva área";
  document.querySelector("#area-feedback").textContent = "";
  areaDialog.showModal();
}

function collectSlots() {
  return [...slotEditorList.querySelectorAll(".slot-editor-row")].map((row) => ({
    id: row.querySelector('[data-slot-field="id"]').value || undefined,
    name: row.querySelector('[data-slot-field="name"]').value,
    startsAt: row.querySelector('[data-slot-field="startsAt"]').value,
    endsAt: row.querySelector('[data-slot-field="endsAt"]').value,
    dayOfWeek: row.querySelector('[data-slot-field="dayOfWeek"]').value,
    active: row.querySelector('[data-slot-field="active"]').checked,
  }));
}

document.addEventListener("naia:authorization", async (event) => {
  profile = event.detail.profile;
  if (!profile) return;
  await loadCalendar();
  if (profile.permissions.includes("reservations.manage")) {
    reservationAdmin.hidden = false;
    await loadAdminData().catch((error) => {
      reservationAdmin.insertAdjacentHTML("beforeend", `<p>${escapeHtml(error.message)}</p>`);
    });
  }
});

document.querySelector("#previous-month").addEventListener("click", () => { viewMonth.setMonth(viewMonth.getMonth() - 1); selectedDate = localDate(new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1, 12)); void loadCalendar(); });
document.querySelector("#next-month").addEventListener("click", () => { viewMonth.setMonth(viewMonth.getMonth() + 1); selectedDate = localDate(new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1, 12)); void loadCalendar(); });
document.querySelector("#today-button").addEventListener("click", () => { viewMonth = new Date(`${today.slice(0, 7)}-01T12:00:00`); selectedDate = today; void loadCalendar(); });

areaFilter.addEventListener("click", (event) => { const button = event.target.closest("[data-area-filter]"); if (!button) return; selectedArea = button.dataset.areaFilter; renderFilters(); renderCalendar(); renderSelectedDay(); });
calendarGrid.addEventListener("click", async (event) => { const button = event.target.closest("[data-calendar-date]"); if (!button) return; selectedDate = button.dataset.calendarDate; await loadEligibility(); renderCalendar(); renderSelectedDay(); });
daySlots.addEventListener("click", async (event) => {
  const reserve = event.target.closest("[data-reserve-area]");
  if (reserve) openReservation(reserve.dataset.reserveArea, reserve.dataset.reserveSlot);
  const cancel = event.target.closest("[data-cancel-reservation]");
  if (cancel && window.confirm("¿Cancelar esta reserva?")) {
    try { await api(`/api/reservations/${cancel.dataset.cancelReservation}/cancel`, { method: "PATCH", body: "{}" }); await loadCalendar(); } catch (error) { window.alert(error.message); }
  }
  const statusButton = event.target.closest("[data-reservation-status]");
  if (statusButton) {
    try {
      await api(`/api/admin/reservations/${statusButton.dataset.reservationId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: statusButton.dataset.reservationStatus }),
      });
      await loadCalendar();
    } catch (error) { window.alert(error.message); }
  }
});

reservationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(reservationForm);
  const submit = reservationForm.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const result = await api("/api/reservations", { method: "POST", body: JSON.stringify({ areaId: formData.get("areaId"), slotId: formData.get("slotId"), date: formData.get("date"), unitId: formData.get("unitId"), guestCount: Number(formData.get("guestCount")), notes: formData.get("notes") }) });
    reservationDialog.close();
    await loadCalendar();
    reservationAlert.hidden = false;
    reservationAlert.innerHTML = `<strong>${result.status === "pending" ? "Solicitud enviada" : "Reserva confirmada"}.</strong><p>El calendario ya fue actualizado.</p>`;
  } catch (error) { document.querySelector("#reservation-feedback").textContent = error.message; } finally { submit.disabled = false; }
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => document.querySelector(`#${button.dataset.closeDialog}`).close()));
document.querySelector("#new-area-button").addEventListener("click", () => openAreaDialog());
document.querySelector("#add-slot-button").addEventListener("click", () => slotEditorList.insertAdjacentHTML("beforeend", slotEditorRow()));
slotEditorList.addEventListener("click", (event) => { const remove = event.target.closest(".slot-remove"); if (remove) remove.closest(".slot-editor-row").remove(); });
areasAdminPanel.addEventListener("click", (event) => { const button = event.target.closest("[data-edit-area]"); if (button) openAreaDialog(adminAreas.find((area) => area.id === button.dataset.editArea)); });

areaForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(areaForm);
  const areaId = formData.get("areaId");
  const submit = areaForm.querySelector('[type="submit"]');
  submit.disabled = true;
  const payload = { name: formData.get("name"), description: formData.get("description"), color: formData.get("color"), capacity: formData.get("capacity"), maxGuests: formData.get("maxGuests"), minNoticeHours: formData.get("minNoticeHours"), maxAdvanceDays: formData.get("maxAdvanceDays"), monthlyLimit: formData.get("monthlyLimit"), cancellationHours: formData.get("cancellationHours"), fee: formData.get("fee"), deposit: formData.get("deposit"), termsText: formData.get("termsText"), active: formData.get("active") === "on", requiresApproval: formData.get("requiresApproval") === "on", allowSundays: formData.get("allowSundays") === "on", allowHolidays: formData.get("allowHolidays") === "on", slots: collectSlots() };
  try {
    await api(areaId ? `/api/admin/reservable-areas/${areaId}` : "/api/admin/reservable-areas", { method: areaId ? "PUT" : "POST", body: JSON.stringify(payload) });
    areaDialog.close();
    await Promise.all([loadAdminData(), loadCalendar()]);
  } catch (error) { document.querySelector("#area-feedback").textContent = error.message; } finally { submit.disabled = false; }
});

document.querySelectorAll("[data-admin-tab]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-admin-tab]").forEach((item) => item.classList.toggle("active", item === button));
  areasAdminPanel.hidden = button.dataset.adminTab !== "areas";
  unitsAdminPanel.hidden = button.dataset.adminTab !== "units";
}));
document.querySelector("#unit-search").addEventListener("input", (event) => renderUnits(event.target.value));
unitsAdminList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-toggle-unit]");
  if (!button) return;
  const unit = units.find((entry) => entry.id === button.dataset.toggleUnit);
  const enabled = !Boolean(unit.reservations_enabled);
  const reason = enabled ? "" : window.prompt("Motivo visible para los residentes de esta vivienda:", "Acceso suspendido por administración") ?? "";
  if (!enabled && !reason) return;
  button.disabled = true;
  try { await api(`/api/admin/units/${unit.id}/reservation-access`, { method: "PATCH", body: JSON.stringify({ enabled, reason }) }); await loadAdminData(); } catch (error) { window.alert(error.message); button.disabled = false; }
});
