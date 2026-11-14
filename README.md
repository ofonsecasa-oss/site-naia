# Portal de Naia Guachipelín

Portal privado del condominio para documentos y, progresivamente, avisos,
reservas y operación residencial.

## Arquitectura actual

- **Clerk** autentica la identidad y administra contraseñas, invitaciones y sesiones.
- **D1** almacena personas, roles, permisos, unidades, ocupación, propiedad y auditoría.
- **Cloudflare Worker** comprueba la sesión y los permisos en cada solicitud protegida.
- **Cloudflare Assets** sirve la interfaz y los documentos actuales.
- **R2** será el repositorio de documentos administrables en la siguiente etapa.

La autorización no se guarda en Clerk. Los roles pueden cambiarse desde
`/admin.html` y el Worker vuelve a consultarlos en D1 en cada solicitud, por lo
que los cambios se aplican inmediatamente. La base de datos impide eliminar,
desactivar o quitar la función al último administrador activo.

`Propietario`, `inquilino` y `residente` son relaciones con una unidad; no son
roles globales. Toda persona activa y aprovisionada puede consultar documentos.
Las funciones globales iniciales son `administrator`, `security` y
`board_member`.

## Reservaciones

El módulo `/reservations` incluye calendario mensual, disponibilidad por
bloques, creación y cancelación de reservas, y vista administrativa para áreas,
reglas y acceso por vivienda. Seguridad puede consultar el calendario y los
datos responsables, pero no administrar ni crear reservas desde su función.

La elegibilidad se calcula con la **ocupación vigente** de una vivienda, no con
la propiedad. Por eso, un propietario no residente cuya casa esté alquilada no
puede reservar; el inquilino u ocupante activo sí puede hacerlo. Administración
puede suspender o reactivar el acceso de una vivienda completa sin desactivar a
sus usuarios.

El reglamento aprobado se usó únicamente para sembrar hechos expresos: Zona BBQ
de 09:00 a 16:00 y de 17:00 a 22:00, Spa sujeto a reserva y Casa Club con aforo
de 40 personas sin incluir la piscina. Los demás límites, anticipación, tarifas,
depósitos y aprobación se configuran por área.

## Preparación local

1. Copiar `.dev.vars.example` como `.dev.vars`.
2. Pegar localmente la llave secreta de Clerk y el correo del administrador
   inicial. Nunca publicar ni enviar esa llave por chat.
3. Instalar dependencias con `npm install`.
4. Aplicar la base local con `npm run db:migrate:local`.
5. Ejecutar `npm run dev` y abrir `http://localhost:8787`.
6. Iniciar sesión, abrir `/admin.html` y crear el administrador inicial.

## Documentos

Mientras se completa la interfaz de carga a R2, los archivos viven en
`dist/documents/` y su catálogo en `dist/app.js`. Las rutas bajo `/documents/`
pasan primero por el Worker y requieren una cuenta activa.

## Producción

Antes de desplegar hay que crear o seleccionar la base D1 remota, reemplazar el
`database_id` provisional de `wrangler.jsonc`, guardar `CLERK_SECRET_KEY` como
secreto de Worker, cambiar `APP_URL` al dominio público y aplicar las migraciones
remotas.
