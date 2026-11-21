require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'luxe_beauty_bar';

const app = express();
app.use(express.json({ limit: '2mb' }));

/* ---------- Permiso para abrir las páginas con Live Server (puerto 5500) ---------- */
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(o)) {
    res.set('Access-Control-Allow-Origin', o);
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.send('Servidor de Luxe Beauty Bar funcionando. Abre tus páginas con Live Server.'));

/* ---------- Base de datos ---------- */
const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
let db;

/* Colecciones que usa la aplicación web (no cambian) */
const NOMBRES = { svc: 'servicios', esp: 'especialistas', cli: 'clientas', ap: 'citas', perm: 'permisos' };
const col = k => db.collection(NOMBRES[k]);
const sinId = { projection: { _id: 0 } };

/* Colecciones nuevas del modelo de datos: las llena el servidor solo, a partir de lo que ya guarda la aplicación.
   La aplicación web no las lee, así que luxe.js y las páginas no necesitan cambios. */
const colD = n => db.collection(n);

const SERVICIOS_INICIALES = [
  { id: 1, n: 'Pestañas', p: 450, d: 90 }, { id: 2, n: 'Uñas', p: 350, d: 60 },
  { id: 3, n: 'Pedicura', p: 400, d: 60 }, { id: 4, n: 'Maquillaje', p: 700, d: 75 },
  { id: 5, n: 'Peinado', p: 500, d: 60 }, { id: 6, n: 'Cejas', p: 250, d: 30 }
];

const AVISO = {
  nueva: 'Nueva cita agendada',
  cambio: 'Cita reprogramada',
  cancel: 'Cita cancelada',
  rechazo: 'Cancelación no aprobada por administración (la cita sigue activa)'
};

const idValido = v => typeof v === 'number' || (typeof v === 'string' && v.length > 0);
const norm = v => String(v == null ? '' : v).trim().toLowerCase();
const ahora = () => new Date().toISOString();

/* Una cita nueva o modificada no puede encimarse con otra activa del mismo especialista y día */
function hayEmpalme(citas, servicios, cambiadas) {
  const dur = Object.fromEntries(servicios.map(s => [s.id, s.d]));
  const min = h => { const [a, b] = String(h).split(':'); return +a * 60 + +b; };
  const activas = citas.filter(a => a.est !== 'cancelada');
  for (const a of cambiadas) {
    if (a.est === 'cancelada') continue;
    const a0 = min(a.h), a1 = a0 + (dur[a.sid] || 60);
    for (const b of activas) {
      if (b.id === a.id || String(b.eid) !== String(a.eid) || b.f !== a.f) continue;
      const b0 = min(b.h), b1 = b0 + (dur[b.sid] || 60);
      if (a0 < b1 && b0 < a1) return true;
    }
  }
  return false;
}

/* ================= Entidades derivadas =================
   pagos                 citas 1:1 pagos (un pago por cita); clientas 1:N pagos
   reembolsos            pagos 1:1 reembolsos
   especialista_servicio especialistas M:N servicios (tabla intermedia)
   notificaciones        citas 1:N notificaciones; clientas 1:N; especialistas 1:N
   solicitudes_cancelacion  citas 1:N solicitudes; especialistas 1:N solicitudes
   permisos              permisos 1:1 especialistas (el permiso se "usa" al registrarse)            */

const upsertSet = (docs, fijos = []) => docs.map(d => {
  const set = { ...d }, ins = {};
  for (const f of fijos) { ins[f] = set[f]; delete set[f]; }
  const update = { $set: set };
  if (fijos.length) update.$setOnInsert = ins;
  return { updateOne: { filter: { id: d.id }, update, upsert: true } };
});

function docsDeCita(a, svcPorId) {
  const s = svcPorId[a.sid];
  const monto = s ? s.p : 0;
  const r = { pago: null, reembolso: null };
  if (['pagado', 'reembolso pendiente', 'reembolsado'].includes(a.pago)) {
    r.pago = {
      id: 'P-' + a.id, aid: a.id, cli: a.cli, monto,
      metodo: a.metodo || 'Pago presencial', tarj: a.tarj || null, fecha: a.fpago || null,
      est: a.pago
    };
  }
  if (a.pago === 'reembolsado') {
    r.reembolso = {
      id: 'R-' + a.id, pid: 'P-' + a.id, aid: a.id, cli: a.cli, monto,
      metodo: a.metodoReemb || null, tarj: a.tarjReemb || null, ref: a.refReemb || null, fecha: a.freemb || null
    };
  }
  return r;
}

async function sincPagos(citas, svcPorId) {
  const pagos = [], reemb = [];
  for (const a of citas) {
    if (a.est === undefined && a.pago === undefined) continue;
    const r = docsDeCita(a, svcPorId);
    if (r.pago) pagos.push(r.pago);
    if (r.reembolso) reemb.push(r.reembolso);
  }
  /* el monto se guarda la primera vez y no cambia aunque después cambie el precio del servicio */
  if (pagos.length) await colD('pagos').bulkWrite(upsertSet(pagos, ['monto']));
  if (reemb.length) await colD('reembolsos').bulkWrite(upsertSet(reemb, ['monto']));
}

async function sincEspServicio(especialistas) {
  for (const e of especialistas) {
    const ids = [...new Set((Array.isArray(e.s) ? e.s : []).filter(idValido))];
    await colD('especialista_servicio').deleteMany({ eid: e.id, sid: { $nin: ids } });
    if (ids.length) await colD('especialista_servicio').bulkWrite(
      ids.map(sid => ({ updateOne: { filter: { id: e.id + '-' + sid }, update: { $set: { id: e.id + '-' + sid, eid: e.id, sid } }, upsert: true } }))
    );
  }
}

async function sincEventosCita(cambiadas, antes) {
  const notis = [], sols = [];
  for (const a of cambiadas) {
    const prev = antes.get(a.id);
    if (a.nueva && (!prev || prev.nueva !== a.nueva || prev.f !== a.f || prev.h !== a.h)) {
      notis.push({
        id: 'N-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
        aid: a.id, cli: a.cli, eid: a.eid, tipo: a.nueva, mensaje: AVISO[a.nueva] || String(a.nueva),
        canal: 'sistema', fecha: ahora(), leida: false
      });
    }
    if (a.solCancel && (!prev || !prev.solCancel || prev.solCancel.t !== a.solCancel.t)) {
      sols.push({
        id: 'S-' + a.id + '-' + a.solCancel.t, aid: a.id, eid: a.eid,
        motivo: a.solCancel.m || '', fecha: new Date(a.solCancel.t).toISOString(), est: 'pendiente'
      });
    } else if (!a.solCancel && prev && prev.solCancel) {
      await colD('solicitudes_cancelacion').updateMany({ aid: a.id, est: 'pendiente' },
        { $set: { est: a.est === 'cancelada' ? 'aprobada' : a.nueva === 'rechazo' ? 'rechazada' : 'cerrada', fresolucion: ahora() } });
    }
  }
  if (notis.length) await colD('notificaciones').insertMany(notis);
  if (sols.length) await colD('solicitudes_cancelacion').bulkWrite(upsertSet(sols, ['est']));
}

/* Un permiso no se borra cuando la especialista se registra: queda como "usado" y apunta a su especialista.
   Solo se borra de verdad si la administradora lo retira antes de que se use. */
async function resolverPermisos(delPerm) {
  if (!delPerm.length) return;
  const registradas = await col('esp').find({}, sinId).toArray();
  for (const id of delPerm) {
    const e = registradas.find(x => norm(x.c) === norm(id));
    if (e) await col('perm').updateOne({ id }, { $set: { usado: true, eid: e.id, fusado: ahora() } });
    else await col('perm').deleteOne({ id });
  }
}

/* Al arrancar: llena las colecciones nuevas con lo que ya existe (se puede repetir sin duplicar) */
async function sincronizarInicial() {
  const [svcDb, espDb, apDb, permDb] = await Promise.all([
    col('svc').find({}, sinId).toArray(), col('esp').find({}, sinId).toArray(),
    col('ap').find({}, sinId).toArray(), col('perm').find({}, sinId).toArray()
  ]);
  const svcPorId = Object.fromEntries(svcDb.map(s => [s.id, s]));
  await sincPagos(apDb, svcPorId);
  await sincEspServicio(espDb);
  const sols = apDb.filter(a => a.solCancel).map(a => ({
    id: 'S-' + a.id + '-' + a.solCancel.t, aid: a.id, eid: a.eid, motivo: a.solCancel.m || '',
    fecha: new Date(a.solCancel.t).toISOString(), est: 'pendiente'
  }));
  if (sols.length) await colD('solicitudes_cancelacion').bulkWrite(upsertSet(sols, ['est']));

  /* Permisos: cada especialista ya registrada tuvo que recibir permiso */
  const conPermiso = new Map(permDb.map(p => [norm(p.id), p]));
  for (const e of espDb) {
    if (!e.c) continue;
    const p = conPermiso.get(norm(e.c));
    if (!p) await col('perm').insertOne({ id: e.c, usado: true, eid: e.id, origen: 'migración' });
    else if (p.usado === undefined) await col('perm').updateOne({ id: p.id }, { $set: { usado: true, eid: e.id, fusado: ahora() } });
  }
  for (const p of permDb) if (p.usado === undefined && !espDb.some(e => norm(e.c) === norm(p.id)))
    await col('perm').updateOne({ id: p.id }, { $set: { usado: false } });
}

/* Una escritura a la vez, para que dos citas simultáneas no se crucen */
let candado = Promise.resolve();
const enFila = fn => { const r = candado.then(fn); candado = r.catch(() => {}); return r; };

app.get('/api/db', async (req, res) => {
  try {
    const [svc, esp, cli, ap, perm] = await Promise.all(Object.keys(NOMBRES).map(k => col(k).find({}, sinId).toArray()));
    res.set('Cache-Control', 'no-store');
    /* la aplicación solo ve los permisos pendientes; los usados quedan en Mongo como historial */
    res.json({ svc, esp, cli, ap, perm: perm.filter(p => !p.usado).map(p => p.id) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error al leer la base de datos' }); }
});

app.post('/api/db', (req, res) => enFila(async () => {
  try {
    const body = req.body || {};
    const ch = body.ch && typeof body.ch === 'object' ? body.ch : {};
    const del = body.del && typeof body.del === 'object' ? body.del : {};
    const nuevos = body.nuevos && typeof body.nuevos === 'object' ? body.nuevos : {};
    const delSvc = Array.isArray(del.svc) ? del.svc.filter(idValido) : [];
    const delPerm = Array.isArray(del.perm) ? del.perm.filter(idValido) : [];

    for (const k of Object.keys(NOMBRES)) {
      const docs = ch[k];
      if (docs === undefined) continue;
      if (!Array.isArray(docs) || docs.length > 500 || docs.some(d => !d || typeof d !== 'object' || !idValido(d.id)))
        return res.status(400).json({ error: 'Datos no válidos' });
    }

    /* Registros de clientas y especialistas: sin ids repetidos ni correos repetidos */
    for (const k of ['esp', 'cli']) {
      for (const id of (Array.isArray(nuevos[k]) ? nuevos[k].filter(idValido) : [])) {
        if (await col(k).findOne({ id }))
          return res.status(409).json({ error: 'Otra persona se registró al mismo tiempo. Vuelve a intentarlo.', recargar: true });
      }
      for (const d of ch[k] || []) {
        if (typeof d.c === 'string' && await col(k).findOne({ c: d.c, id: { $ne: d.id } }))
          return res.status(409).json({ error: 'Ese correo ya está registrado.', recargar: true });
      }
    }

    /* Empalme de horarios */
    const [svcDb, apDb] = await Promise.all([col('svc').find({}, sinId).toArray(), col('ap').find({}, sinId).toArray()]);
    const servicios = svcDb.filter(s => !delSvc.includes(s.id)).concat(ch.svc || []);
    const citas = new Map(apDb.map(a => [a.id, a]));
    const antes = new Map(citas);               /* cómo estaban las citas antes de este guardado */
    (ch.ap || []).forEach(a => citas.set(a.id, a));
    if (hayEmpalme([...citas.values()], servicios, ch.ap || []))
      return res.status(409).json({ error: 'Ese horario ya fue ocupado por otra cita. Elige otro.' });

    /* Guardar */
    for (const k of Object.keys(NOMBRES)) {
      let docs = ch[k] || [];
      if (k === 'perm') docs = docs.map(d => ({ id: d.id, usado: false, otorgado: ahora() }));
      if (docs.length) await col(k).bulkWrite(docs.map(d => ({ replaceOne: { filter: { id: d.id }, replacement: d, upsert: true } })));
    }
    if (delSvc.length) await col('svc').deleteMany({ id: { $in: delSvc } });
    await resolverPermisos(delPerm);

    /* Entidades derivadas: si algo falla aquí, el guardado principal ya quedó hecho */
    try {
      const svcPorId = Object.fromEntries(servicios.map(s => [s.id, s]));
      if (ch.ap) { await sincPagos(ch.ap, svcPorId); await sincEventosCita(ch.ap, antes); }
      if (ch.esp) await sincEspServicio(ch.esp);
      if (delSvc.length) await colD('especialista_servicio').deleteMany({ sid: { $in: delSvc } });
    } catch (e) { console.error('Entidades derivadas:', e.message); }

    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error al guardar en la base de datos' }); }
}));

/* Índices: 'id' único en todas; las llaves foráneas indexadas para que las relaciones sean rápidas */
const INDICES = {
  citas: [{ cli: 1 }, { eid: 1 }, { sid: 1 }],
  permisos: [{ eid: 1 }],
  pagos: [{ aid: 1 }, { cli: 1 }],
  reembolsos: [{ aid: 1 }, { pid: 1 }],
  especialista_servicio: [{ eid: 1 }, { sid: 1 }],
  notificaciones: [{ aid: 1 }, { cli: 1 }, { eid: 1 }],
  solicitudes_cancelacion: [{ aid: 1 }, { eid: 1 }]
};
const NUEVAS = ['pagos', 'reembolsos', 'especialista_servicio', 'notificaciones', 'solicitudes_cancelacion'];

(async () => {
  try {
    await client.connect();
    db = client.db(DB_NAME);
    for (const k of Object.keys(NOMBRES)) await col(k).createIndex({ id: 1 }, { unique: true });
    for (const n of NUEVAS) await colD(n).createIndex({ id: 1 }, { unique: true });
    await colD('especialista_servicio').createIndex({ eid: 1, sid: 1 }, { unique: true });
    for (const [n, lista] of Object.entries(INDICES)) for (const k of lista) await colD(n).createIndex(k);
    const vacia = (await Promise.all(['svc', 'esp', 'cli', 'ap'].map(k => col(k).countDocuments()))).every(n => n === 0);
    if (vacia) await col('svc').insertMany(SERVICIOS_INICIALES);
    try { await sincronizarInicial(); } catch (e) { console.error('Sincronización inicial:', e.message); }
    app.listen(PORT, () => console.log(`Servidor listo en http://localhost:${PORT} · base: ${DB_NAME}`));
  } catch (e) {
    console.error('No se pudo iniciar:', e.message);
    process.exit(1);
  }
})();