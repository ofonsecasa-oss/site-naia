const documents = [
  {
    name: "Escritura de constitución · Condominio Naia",
    description: "Documento constitutivo y marco registral del condominio.",
    category: "Legal",
    type: "PDF",
    date: "2026-11-13",
    displayDate: "13 nov 2026",
    size: "9.9 MB",
    sizeBytes: 10410621,
    tags: ["escritura", "constitución", "legal", "registro", "condominio"],
    url: "./documents/escritura-constitucion-naia.pdf",
  },
  {
    name: "Reglamento del condominio horizontal",
    description: "Reglamento general del Condominio Horizontal Residencial Naia.",
    category: "Reglamentos",
    type: "PDF",
    date: "2026-11-13",
    displayDate: "13 nov 2026",
    size: "161 KB",
    sizeBytes: 164847,
    tags: ["reglamento", "condominio horizontal", "residencial", "normativa"],
    url: "./documents/reglamento-condominio-horizontal-naia.pdf",
  },
  {
    name: "Reglamento interno de áreas comunes",
    description: "Normas aprobadas para el uso y convivencia en las áreas comunes.",
    category: "Reglamentos",
    type: "PDF",
    date: "2026-11-13",
    displayDate: "13 nov 2026",
    size: "190 KB",
    sizeBytes: 194916,
    tags: ["reglamento", "áreas comunes", "uso", "convivencia", "aprobado"],
    url: "./documents/reglamento-areas-comunes-aprobado.pdf",
  },
  {
    name: "Presupuesto revisado 2026–2027",
    description: "Propuesta ajustada, comparación y plan de capital de trabajo.",
    category: "Presupuestos",
    type: "XLSX",
    date: "2026-10-15",
    displayDate: "15 oct 2026",
    size: "52 KB",
    sizeBytes: 51593,
    tags: ["cuota", "presupuesto", "comparación", "seguro"],
    url: "./documents/presupuesto-revisado-2026-2027.xlsx",
  },
  {
    name: "Borrador de presupuesto de administración",
    description: "Propuesta original para noviembre 2026–octubre 2027.",
    category: "Presupuestos",
    type: "XLSX",
    date: "2026-10-15",
    displayDate: "15 oct 2026",
    size: "33 KB",
    sizeBytes: 33400,
    tags: ["administración", "cuota", "borrador"],
    url: "./documents/borrador-presupuesto-admin-2026-2027.xlsx",
  },
  {
    name: "Información financiera · agosto 2026",
    description: "Estados, ejecución mensual, provisiones y cuentas por cobrar.",
    category: "Finanzas",
    type: "PDF",
    date: "2026-08-31",
    displayDate: "31 ago 2026",
    size: "431 KB",
    sizeBytes: 441419,
    tags: ["estados financieros", "agosto", "ejecución", "liquidez"],
    url: "./documents/informacion-financiera-agosto-2026.pdf",
  },
  {
    name: "Flujo de caja · agosto 2026",
    description: "Ingresos, pagos y conciliación del saldo bancario del mes.",
    category: "Finanzas",
    type: "XLSX",
    date: "2026-08-31",
    displayDate: "31 ago 2026",
    size: "45 KB",
    sizeBytes: 46093,
    tags: ["flujo de caja", "bancos", "agosto", "pagos"],
    url: "./documents/flujo-caja-agosto-2026.xlsx",
  },
  {
    name: "Facturas y comprobantes · agosto 2026",
    description: "Respaldo documental de los pagos ejecutados durante agosto.",
    category: "Finanzas",
    type: "PDF",
    date: "2026-08-31",
    displayDate: "31 ago 2026",
    size: "4.6 MB",
    sizeBytes: 4840188,
    tags: ["facturas", "comprobantes", "electricidad", "agua"],
    url: "./documents/facturas-agosto-2026.pdf",
  },
  {
    name: "Acta de Asamblea · abril 2026",
    description: "Acuerdos de asamblea y presupuesto aprobado para 68 filiales.",
    category: "Asambleas",
    type: "PDF",
    date: "2026-04-16",
    displayDate: "16 abr 2026",
    size: "143 KB",
    sizeBytes: 146570,
    tags: ["acta", "asamblea", "acuerdos", "filiales"],
    url: "./documents/acta-asamblea-abril-2026.pdf",
  },
  {
    name: "Póliza multirriesgo y responsabilidad civil",
    description: "Resumen de coberturas, deducibles y prima de la póliza vigente.",
    category: "Seguros",
    type: "Imagen",
    date: "2026-01-01",
    displayDate: "Vigente",
    size: "65 KB",
    sizeBytes: 66178,
    tags: ["póliza", "seguro", "responsabilidad civil", "INS"],
    url: "./documents/poliza-multirriesgo.jpeg",
  },
];

const state = {
  query: "",
  category: "Todos",
  sort: "date-desc",
  view: localStorage.getItem("naia-document-view") || "list",
};

const list = document.querySelector("#document-list");
const search = document.querySelector("#document-search");
const resultsCount = document.querySelector("#results-count");
const clearFilters = document.querySelector("#clear-filters");
const emptyState = document.querySelector("#empty-state");
const sortSelect = document.querySelector("#sort-select");
const toast = document.querySelector("#toast");
let toastTimer;

const normalize = (value) => value
  .toLocaleLowerCase("es")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "");

function filteredDocuments() {
  const query = normalize(state.query.trim());
  const filtered = documents.filter((doc) => {
    const categoryMatch = state.category === "Todos" || doc.category === state.category;
    const haystack = normalize([doc.name, doc.description, doc.category, doc.type, ...doc.tags].join(" "));
    return categoryMatch && (!query || haystack.includes(query));
  });

  return filtered.sort((a, b) => {
    switch (state.sort) {
      case "date-asc": return a.date.localeCompare(b.date);
      case "name-asc": return a.name.localeCompare(b.name, "es");
      case "category-asc": return a.category.localeCompare(b.category, "es") || a.name.localeCompare(b.name, "es");
      case "size-desc": return b.sizeBytes - a.sizeBytes;
      default: return b.date.localeCompare(a.date) || a.name.localeCompare(b.name, "es");
    }
  });
}

function documentTemplate(doc) {
  const fileClass = doc.type === "XLSX" ? "xlsx" : doc.type === "Imagen" ? "image" : "pdf";
  const fileLabel = doc.type === "Imagen" ? "IMG" : doc.type;
  return `
    <a class="document-card" role="listitem" href="${doc.url}" target="_blank" rel="noopener" aria-label="Abrir ${doc.name}">
      <span class="file-icon ${fileClass}" aria-hidden="true">${fileLabel}</span>
      <span class="document-primary">
        <h3>${doc.name}</h3>
        <p>${doc.description}</p>
      </span>
      <span class="document-meta"><small>Actualizado</small><span>${doc.displayDate}</span></span>
      <span class="document-meta"><small>Archivo</small><span>${doc.type} · ${doc.size}</span></span>
      <span class="category-tag">${doc.category}</span>
      <span class="open-button" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg>
      </span>
    </a>`;
}

function render() {
  const items = filteredDocuments();
  list.innerHTML = items.map(documentTemplate).join("");
  list.classList.toggle("grid-view", state.view === "grid");
  resultsCount.textContent = `${items.length} ${items.length === 1 ? "documento" : "documentos"}`;
  emptyState.hidden = items.length !== 0;
  list.hidden = items.length === 0;
  clearFilters.hidden = !state.query && state.category === "Todos";

  document.querySelectorAll(".filter-chip").forEach((button) => {
    button.classList.toggle("active", button.dataset.category === state.category);
  });
  document.querySelectorAll(".view-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.view);
  });
}

function resetFilters() {
  state.query = "";
  state.category = "Todos";
  search.value = "";
  render();
}

search.addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});

document.querySelectorAll(".filter-chip").forEach((button) => {
  button.addEventListener("click", () => {
    state.category = button.dataset.category;
    render();
  });
});

sortSelect.addEventListener("change", (event) => {
  state.sort = event.target.value;
  render();
});

document.querySelectorAll(".view-button").forEach((button) => {
  button.addEventListener("click", () => {
    state.view = button.dataset.view;
    localStorage.setItem("naia-document-view", state.view);
    render();
  });
});

clearFilters.addEventListener("click", resetFilters);
document.querySelector("#empty-clear").addEventListener("click", resetFilters);

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    search.focus();
    search.select();
  }
  if (event.key === "Escape" && document.activeElement === search) {
    search.value = "";
    state.query = "";
    search.blur();
    render();
  }
});

function showToast(section) {
  clearTimeout(toastTimer);
  document.querySelector("#toast-title").textContent = `${section}: próxima etapa`;
  document.querySelector("#toast-message").textContent = section === "Reservas"
    ? "La estructura contempla un calendario para las áreas comunes."
    : "La estructura contempla comunicados y notificaciones para residentes.";
  toast.classList.add("visible");
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 4200);
}

document.querySelectorAll(".future-link").forEach((button) => {
  button.addEventListener("click", () => showToast(button.dataset.future));
});
document.querySelector("#toast-close").addEventListener("click", () => toast.classList.remove("visible"));
document.querySelector(".resident-button")?.addEventListener("click", () => showToast("Perfil de residente"));

document.querySelector("#hero-document-count").textContent = documents.length;
document.querySelector("#all-count").textContent = documents.length;
document.querySelector("#pdf-count").textContent = documents.filter((doc) => doc.type === "PDF").length;
document.querySelector("#sheet-count").textContent = documents.filter((doc) => doc.type === "XLSX").length;

render();
