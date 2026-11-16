CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL CHECK (category IN ('Finanzas', 'Presupuestos', 'Asambleas', 'Seguros', 'Reglamentos', 'Legal', 'Otros')),
  tags_json TEXT NOT NULL DEFAULT '[]',
  file_type TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  storage_backend TEXT NOT NULL CHECK (storage_backend IN ('asset', 'r2')),
  storage_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  document_date TEXT NOT NULL,
  display_date TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT REFERENCES people(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_documents_active_date ON documents(active, document_date DESC);
CREATE INDEX idx_documents_category ON documents(category, active);

INSERT INTO documents
  (id, name, description, category, tags_json, file_type, mime_type, original_filename,
   storage_backend, storage_key, size_bytes, document_date, display_date)
VALUES
  ('doc-escritura-constitucion', 'Escritura de constitución · Condominio Naia', 'Documento constitutivo y marco registral del condominio.', 'Legal', '["escritura","constitución","legal","registro","condominio"]', 'PDF', 'application/pdf', 'escritura-constitucion-naia.pdf', 'asset', 'documents/escritura-constitucion-naia.pdf', 10410621, '2026-11-13', '13 nov 2026'),
  ('doc-reglamento-horizontal', 'Reglamento del condominio horizontal', 'Reglamento general del Condominio Horizontal Residencial Naia.', 'Reglamentos', '["reglamento","condominio horizontal","residencial","normativa"]', 'PDF', 'application/pdf', 'reglamento-condominio-horizontal-naia.pdf', 'asset', 'documents/reglamento-condominio-horizontal-naia.pdf', 164847, '2026-11-13', '13 nov 2026'),
  ('doc-reglamento-areas-comunes', 'Reglamento interno de áreas comunes', 'Normas aprobadas para el uso y convivencia en las áreas comunes.', 'Reglamentos', '["reglamento","áreas comunes","uso","convivencia","aprobado"]', 'PDF', 'application/pdf', 'reglamento-areas-comunes-aprobado.pdf', 'asset', 'documents/reglamento-areas-comunes-aprobado.pdf', 194916, '2026-11-13', '13 nov 2026'),
  ('doc-presupuesto-revisado', 'Presupuesto revisado 2026–2027', 'Propuesta ajustada, comparación y plan de capital de trabajo.', 'Presupuestos', '["cuota","presupuesto","comparación","seguro"]', 'XLSX', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'presupuesto-revisado-2026-2027.xlsx', 'asset', 'documents/presupuesto-revisado-2026-2027.xlsx', 51593, '2026-10-15', '15 oct 2026'),
  ('doc-borrador-presupuesto', 'Borrador de presupuesto de administración', 'Propuesta original para noviembre 2026–octubre 2027.', 'Presupuestos', '["administración","cuota","borrador"]', 'XLSX', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'borrador-presupuesto-admin-2026-2027.xlsx', 'asset', 'documents/borrador-presupuesto-admin-2026-2027.xlsx', 33400, '2026-10-15', '15 oct 2026'),
  ('doc-finanzas-agosto', 'Información financiera · agosto 2026', 'Estados, ejecución mensual, provisiones y cuentas por cobrar.', 'Finanzas', '["estados financieros","agosto","ejecución","liquidez"]', 'PDF', 'application/pdf', 'informacion-financiera-agosto-2026.pdf', 'asset', 'documents/informacion-financiera-agosto-2026.pdf', 441419, '2026-08-31', '31 ago 2026'),
  ('doc-flujo-caja-agosto', 'Flujo de caja · agosto 2026', 'Ingresos, pagos y conciliación del saldo bancario del mes.', 'Finanzas', '["flujo de caja","bancos","agosto","pagos"]', 'XLSX', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'flujo-caja-agosto-2026.xlsx', 'asset', 'documents/flujo-caja-agosto-2026.xlsx', 46093, '2026-08-31', '31 ago 2026'),
  ('doc-facturas-agosto', 'Facturas y comprobantes · agosto 2026', 'Respaldo documental de los pagos ejecutados durante agosto.', 'Finanzas', '["facturas","comprobantes","electricidad","agua"]', 'PDF', 'application/pdf', 'facturas-agosto-2026.pdf', 'asset', 'documents/facturas-agosto-2026.pdf', 4840188, '2026-08-31', '31 ago 2026'),
  ('doc-acta-abril', 'Acta de Asamblea · abril 2026', 'Acuerdos de asamblea y presupuesto aprobado para 68 filiales.', 'Asambleas', '["acta","asamblea","acuerdos","filiales"]', 'PDF', 'application/pdf', 'acta-asamblea-abril-2026.pdf', 'asset', 'documents/acta-asamblea-abril-2026.pdf', 146570, '2026-04-16', '16 abr 2026'),
  ('doc-poliza-multirriesgo', 'Póliza multirriesgo y responsabilidad civil', 'Resumen de coberturas, deducibles y prima de la póliza vigente.', 'Seguros', '["póliza","seguro","responsabilidad civil","INS"]', 'Imagen', 'image/jpeg', 'poliza-multirriesgo.jpeg', 'asset', 'documents/poliza-multirriesgo.jpeg', 66178, '2026-01-01', 'Vigente');
