const adminStatus = document.querySelector("#admin-status");
const adminWorkspace = document.querySelector("#admin-workspace");
const bootstrapCard = document.querySelector("#bootstrap-card");
const bootstrapButton = document.querySelector("#bootstrap-button");
const inviteForm = document.querySelector("#invite-form");
const inviteFeedback = document.querySelector("#invite-feedback");
const inviteRoleOptions = document.querySelector("#invite-role-options");
const peopleBody = document.querySelector("#people-body");
const emptyPeople = document.querySelector("#empty-people");
const roleDialog = document.querySelector("#role-dialog");
const roleForm = document.querySelector("#role-form");
const dialogRoleOptions = document.querySelector("#dialog-role-options");
const housingDialog = document.querySelector("#housing-dialog");
const housingForm = document.querySelector("#housing-form");

let roles = [];
let people = [];

function currentCostaRicaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Costa_Rica",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function roleLabel(key) {
  return roles.find((role) => role.key === key)?.name_es || key;
}

function errorMessage(code) {
  return ({
    email_already_exists: "Ya existe una persona con ese correo.",
    invitation_failed: "La persona se creó, pero Clerk no pudo enviar la invitación.",
    last_administrator: "No se puede retirar o desactivar al último administrador activo.",
    forbidden: "Tu cuenta no tiene permiso para realizar esta acción.",
    bootstrap_email_mismatch: "Tu correo no coincide con el administrador inicial configurado.",
  })[code] || "No pudimos completar la acción.";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", Accept: "application/json", ...options.headers },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(errorMessage(payload.error)), { code: payload.error, status: response.status });
  return payload;
}

function roleCheckboxes(selected = [], prefix = "role") {
  return roles.map((role) => `
    <label class="role-option">
      <input type="checkbox" name="roles" value="${escapeHtml(role.key)}" ${selected.includes(role.key) ? "checked" : ""} />
      <span><strong>${escapeHtml(role.name_es)}</strong><small>${escapeHtml(role.description_es)}</small></span>
    </label>`).join("");
}

async function loadRoles() {
  const payload = await api("/api/admin/roles");
  roles = payload.roles;
  inviteRoleOptions.innerHTML = roleCheckboxes([], "invite-role");
}

function renderPeople() {
  emptyPeople.hidden = people.length !== 0;
  peopleBody.innerHTML = people.map((person) => `
    <tr>
      <td><strong>${escapeHtml(person.first_name)} ${escapeHtml(person.last_name)}</strong><small>${escapeHtml(person.email)}</small></td>
      <td><span class="person-status ${escapeHtml(person.status)}">${person.status === "active" ? "Activo" : person.status === "pending" ? "Pendiente" : "Inactivo"}</span></td>
      <td><div class="role-chips">${person.roles.length ? person.roles.map((role) => `<span>${escapeHtml(roleLabel(role))}</span>`).join("") : "<em>Sin función global</em>"}</div></td>
      <td class="person-actions"><button type="button" data-edit-housing="${escapeHtml(person.id)}">Vivienda</button><button type="button" data-edit-roles="${escapeHtml(person.id)}">Funciones</button><button type="button" data-toggle-status="${escapeHtml(person.id)}">${person.status === "inactive" ? "Activar" : "Desactivar"}</button></td>
    </tr>`).join("");
}

async function loadPeople() {
  const payload = await api("/api/admin/people");
  people = payload.people;
  renderPeople();
}

async function initializeAdmin() {
  bootstrapButton.disabled = true;
  bootstrapButton.textContent = "Inicializando…";
  try {
    await api("/api/bootstrap", { method: "POST", body: "{}" });
    window.location.reload();
  } catch (error) {
    adminStatus.innerHTML = `<strong>No se pudo inicializar.</strong><p>${escapeHtml(error.message)}</p>`;
    bootstrapButton.disabled = false;
    bootstrapButton.textContent = "Crear administrador inicial";
  }
}

document.addEventListener("naia:authorization", async (event) => {
  const { profile, error } = event.detail;
  if (!profile) {
    adminStatus.innerHTML = error === "account_not_provisioned"
      ? "<strong>La base está lista para su primer administrador.</strong><p>Verifica que tu correo esté configurado como BOOTSTRAP_ADMIN_EMAIL.</p>"
      : `<strong>Administración no disponible.</strong><p>${escapeHtml(error || "No se pudo consultar el backend.")}</p>`;
    bootstrapCard.hidden = error !== "account_not_provisioned";
    return;
  }

  if (!profile.permissions.includes("people.read")) {
    adminStatus.innerHTML = "<strong>Acceso restringido.</strong><p>Tu cuenta no tiene permisos administrativos.</p>";
    return;
  }

  adminStatus.innerHTML = `<strong>Sesión autorizada.</strong><p>${escapeHtml(profile.person.first_name)}, los cambios de funciones se aplican inmediatamente.</p>`;
  adminWorkspace.hidden = false;
  try {
    await Promise.all([loadRoles(), loadPeople()]);
  } catch (loadError) {
    adminStatus.innerHTML = `<strong>No se pudieron cargar los usuarios.</strong><p>${escapeHtml(loadError.message)}</p>`;
  }
});

bootstrapButton.addEventListener("click", initializeAdmin);
document.querySelector("#refresh-people").addEventListener("click", loadPeople);

inviteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = inviteForm.querySelector("button[type='submit']");
  const formData = new FormData(inviteForm);
  submit.disabled = true;
  inviteFeedback.textContent = "Creando persona y enviando invitación…";
  try {
    await api("/api/admin/people", {
      method: "POST",
      body: JSON.stringify({
        firstName: formData.get("firstName"),
        lastName: formData.get("lastName"),
        email: formData.get("email"),
        roles: formData.getAll("roles"),
      }),
    });
    inviteForm.reset();
    inviteFeedback.textContent = "Invitación enviada correctamente.";
    await loadPeople();
  } catch (error) {
    inviteFeedback.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

peopleBody.addEventListener("click", async (event) => {
  const roleButton = event.target.closest("[data-edit-roles]");
  const housingButton = event.target.closest("[data-edit-housing]");
  const statusButton = event.target.closest("[data-toggle-status]");

  if (housingButton) {
    const person = people.find((entry) => entry.id === housingButton.dataset.editHousing);
    if (!person) return;
    housingButton.disabled = true;
    try {
      const payload = await api(`/api/admin/people/${person.id}/housing`);
      housingForm.reset();
      housingForm.elements.personId.value = person.id;
      document.querySelector("#housing-dialog-title").textContent = `${person.first_name} ${person.last_name}`;
      const options = `<option value="">No registrada</option>${payload.units.map((unit) => `<option value="${escapeHtml(unit.id)}">Vivienda ${escapeHtml(unit.number)}</option>`).join("")}`;
      housingForm.elements.ownershipUnitId.innerHTML = options;
      housingForm.elements.occupancyUnitId.innerHTML = options.replace("No registrada", "No reside actualmente en Naia");
      const currentDate = currentCostaRicaDate();
      const ownership = payload.ownerships.find((entry) => !entry.ends_on || entry.ends_on >= currentDate);
      const occupancy = payload.occupancies.find((entry) => !entry.ends_on || entry.ends_on >= currentDate);
      housingForm.elements.ownershipUnitId.value = ownership?.unit_id || "";
      housingForm.elements.occupancyUnitId.value = occupancy?.unit_id || "";
      housingForm.elements.occupancyType.value = occupancy?.occupancy_type || "owner_resident";
      housingForm.elements.startsOn.value = occupancy?.starts_on || currentDate;
      housingForm.elements.endsOn.value = occupancy?.ends_on || "";
      document.querySelector("#housing-feedback").textContent = "";
      housingDialog.showModal();
    } catch (error) {
      window.alert(error.message);
    } finally {
      housingButton.disabled = false;
    }
  }

  if (roleButton) {
    const person = people.find((entry) => entry.id === roleButton.dataset.editRoles);
    if (!person) return;
    roleForm.elements.personId.value = person.id;
    document.querySelector("#role-dialog-title").textContent = `${person.first_name} ${person.last_name}`;
    dialogRoleOptions.innerHTML = roleCheckboxes(person.roles, "dialog-role");
    roleDialog.showModal();
  }

  if (statusButton) {
    const person = people.find((entry) => entry.id === statusButton.dataset.toggleStatus);
    if (!person) return;
    const status = person.status === "inactive" ? "active" : "inactive";
    statusButton.disabled = true;
    try {
      await api(`/api/admin/people/${person.id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      await loadPeople();
    } catch (error) {
      window.alert(error.message);
      statusButton.disabled = false;
    }
  }
});

roleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(roleForm);
  const saveButton = document.querySelector("#save-roles");
  saveButton.disabled = true;
  try {
    await api(`/api/admin/people/${formData.get("personId")}/roles`, {
      method: "PUT",
      body: JSON.stringify({ roles: formData.getAll("roles") }),
    });
    roleDialog.close();
    await loadPeople();
  } catch (error) {
    window.alert(error.message);
  } finally {
    saveButton.disabled = false;
  }
});

housingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(housingForm);
  const submit = housingForm.querySelector('[type="submit"]');
  const ownershipUnitId = formData.get("ownershipUnitId");
  const occupancyUnitId = formData.get("occupancyUnitId");
  submit.disabled = true;
  try {
    await api(`/api/admin/people/${formData.get("personId")}/housing`, {
      method: "PUT",
      body: JSON.stringify({
        ownerships: ownershipUnitId ? [{ unitId: ownershipUnitId }] : [],
        occupancies: occupancyUnitId ? [{
          unitId: occupancyUnitId,
          occupancyType: formData.get("occupancyType"),
          startsOn: formData.get("startsOn"),
          endsOn: formData.get("endsOn") || null,
        }] : [],
      }),
    });
    housingDialog.close();
  } catch (error) {
    document.querySelector("#housing-feedback").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#close-housing-dialog").addEventListener("click", () => housingDialog.close());
document.querySelector("#cancel-housing-dialog").addEventListener("click", () => housingDialog.close());
