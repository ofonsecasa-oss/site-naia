const authGate = document.querySelector("#auth-gate");
const authLoading = document.querySelector("#auth-loading");
const authError = document.querySelector("#auth-error");
const signInContainer = document.querySelector("#clerk-sign-in");
const portalShell = document.querySelector("#portal-shell");
const userButtonContainer = document.querySelector("#clerk-user-button");
const residentName = document.querySelector("#resident-name");

const clerkAppearance = {
  variables: {
    colorPrimary: "#a84132",
    colorForeground: "#2d2928",
    colorBackground: "#fffdfb",
    colorInputBackground: "#ffffff",
    colorInputText: "#2d2928",
    colorBorder: "#e5ddd7",
    borderRadius: "0.875rem",
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
};

let signInMounted = false;
let userButtonMounted = false;

function isAdminRoute() {
  return /^\/admin(?:\.html)?\/?$/.test(window.location.pathname);
}

function isSecurityRoute() {
  return /^\/(?:seguridad|security)(?:\.html)?\/?$/.test(window.location.pathname);
}

function displayName(user) {
  if (!user) return "Residente";
  return user.fullName
    || [user.firstName, user.lastName].filter(Boolean).join(" ")
    || user.primaryEmailAddress?.emailAddress
    || "Residente";
}

function showSignedOut() {
  document.body.classList.remove("authenticated");
  document.body.classList.add("signed-out");
  portalShell.hidden = true;
  authGate.hidden = false;
  authLoading.hidden = true;
  authError.hidden = true;
  signInContainer.hidden = false;

  if (!signInMounted) {
    Clerk.mountSignIn(signInContainer, {
      routing: "hash",
      appearance: clerkAppearance,
    });
    signInMounted = true;
  }
}

function showSignedIn(user) {
  document.body.classList.remove("auth-pending", "signed-out");
  document.body.classList.add("authenticated");
  authGate.hidden = true;
  portalShell.hidden = false;
  residentName.textContent = displayName(user);

  if (!userButtonMounted) {
    Clerk.mountUserButton(userButtonContainer, {
      appearance: clerkAppearance,
      userProfileProps: { appearance: clerkAppearance },
    });
    userButtonMounted = true;
  }

  void hydrateAuthorization(user);
}

function showAccessMessage(title, message) {
  portalShell.hidden = true;
  authGate.hidden = false;
  authLoading.hidden = true;
  signInContainer.hidden = true;
  authError.hidden = false;
  authError.querySelector("strong").textContent = title;
  authError.querySelector("p").textContent = message;
  const button = authError.querySelector("button");
  button.textContent = "Cerrar sesión";
  button.onclick = () => Clerk.signOut();
}

async function hydrateAuthorization(user) {
  let detail;
  try {
    const response = await fetch("/api/me", { headers: { Accept: "application/json" } });
    const payload = await response.json().catch(() => ({}));

    if (response.ok) {
      detail = { user, profile: payload, error: null };
      const securityOnly = payload.roles.includes("security") && !payload.roles.includes("administrator");
      document.body.classList.toggle("security-only", securityOnly);
      if (securityOnly && !isSecurityRoute()) {
        window.location.replace("/seguridad");
        return;
      }
      document.querySelectorAll("[data-permission]").forEach((element) => {
        element.hidden = !payload.permissions.includes(element.dataset.permission);
      });

      const isDocumentPortal = !isAdminRoute();
      if (isDocumentPortal && !payload.permissions.includes("documents.read")) {
        showAccessMessage("Acceso limitado", "Tu cuenta no tiene permiso para consultar documentos.");
      }
    } else {
      detail = { user, profile: null, error: payload.error || `http_${response.status}` };
      const isAdminPage = isAdminRoute();
      const backendUnavailable = response.status === 404;

      if (!backendUnavailable && !isAdminPage) {
        const pending = detail.error === "account_not_provisioned";
        showAccessMessage(
          pending ? "Cuenta pendiente" : "Acceso no disponible",
          pending
            ? "Tu identidad está verificada, pero la administración aún no ha habilitado tu cuenta."
            : "Tu cuenta está inactiva o no tiene acceso a este portal."
        );
      }
    }
  } catch {
    detail = { user, profile: null, error: "backend_unavailable" };
  }

  document.dispatchEvent(new CustomEvent("naia:authorization", { detail }));
}

function renderAuthState() {
  if (Clerk.isSignedIn && Clerk.user) {
    showSignedIn(Clerk.user);
  } else {
    showSignedOut();
  }
}

window.addEventListener("load", async () => {
  try {
    if (!window.Clerk) throw new Error("ClerkJS no está disponible");

    await Clerk.load({
      ui: { ClerkUI: window.__internal_ClerkUICtor },
      appearance: clerkAppearance,
    });

    Clerk.addListener(renderAuthState);
    renderAuthState();
  } catch (error) {
    console.error("No se pudo iniciar Clerk", error);
    authLoading.hidden = true;
    signInContainer.hidden = true;
    authError.hidden = false;
  }
});
