
const bd = db.getSiblingDB('Proyecto_salon');

//   Clave primaria  -> campo "id" con índice ÚNICO
//   Clave foránea   -> campo que guarda el "id" de otra colección
const ENTIDADES = {
  servicios: {
    pk: 'id', fk: {},
    required: ['id', 'n', 'p', 'd']            // n=nombre, p=precio, d=duración (min)
  },
  clientas: {                                  
    pk: 'id', fk: {},
    required: ['id', 'n', 'c']                 // n=nombre, c=correo, t=teléfono
  },
  especialistas: {
    pk: 'id', fk: {},
    required: ['id', 'n', 'c']                 
  },
  permisos: {
    pk: 'id', fk: { eid: 'especialistas.id' },  // permiso usado -> especialista
    required: ['id']
  },
  citas: {
    pk: 'id',
    fk: { cli: 'clientas.id', eid: 'especialistas.id', sid: 'servicios.id' },
    required: ['id', 'cli', 'eid', 'sid', 'f', 'h']   // f=fecha, h=hora
  },
  pagos: {                                      // citas 1:1 pagos
    pk: 'id', fk: { aid: 'citas.id', cli: 'clientas.id' },
    required: ['id', 'aid', 'cli', 'monto']
  },
  reembolsos: {                                 // pagos 1:1 reembolsos
    pk: 'id', fk: { pid: 'pagos.id', aid: 'citas.id', cli: 'clientas.id' },
    required: ['id', 'pid', 'aid', 'cli', 'monto']
  },
  especialista_servicio: {                      // especialistas M:N servicios
    pk: 'id', fk: { eid: 'especialistas.id', sid: 'servicios.id' },
    required: ['id', 'eid', 'sid']
  },
  notificaciones: {                             // citas 1:N notificaciones
    pk: 'id', fk: { aid: 'citas.id', cli: 'clientas.id', eid: 'especialistas.id' },
    required: ['id', 'aid', 'cli', 'eid', 'tipo']
  },
  solicitudes_cancelacion: {                    // citas 1:N solicitudes
    pk: 'id', fk: { aid: 'citas.id', eid: 'especialistas.id' },
    required: ['id', 'aid', 'eid']
  }
};

const existentes = bd.getCollectionNames();

for (const [nombre, def] of Object.entries(ENTIDADES)) {
  const validator = { $jsonSchema: { bsonType: 'object', required: def.required } };

  if (!existentes.includes(nombre)) {
    bd.createCollection(nombre, { validator, validationLevel: 'moderate', validationAction: 'warn' });
    print('Colección creada: ' + nombre);
  } else {
    bd.runCommand({ collMod: nombre, validator, validationLevel: 'moderate', validationAction: 'warn' });
    print('Colección ya existía (validación actualizada): ' + nombre);
  }

  // Clave primaria: id único
  bd.getCollection(nombre).createIndex({ [def.pk]: 1 }, { unique: true });

  // Claves foráneas
  for (const campo of Object.keys(def.fk)) {
    bd.getCollection(nombre).createIndex({ [campo]: 1 });
  }
}

// Relación muchos a muchos: una especialista no repite el mismo servicio
bd.especialista_servicio.createIndex({ eid: 1, sid: 1 }, { unique: true });
// Un solo pago por cita y un solo reembolso por pago (relaciones 1:1)
bd.pagos.createIndex({ aid: 1 }, { unique: true, name: 'aid_unico' });
bd.reembolsos.createIndex({ pid: 1 }, { unique: true, name: 'pid_unico' });

bd.clientas.createIndex({ c: 1 }, { unique: true, name: 'correo_unico' });
bd.especialistas.createIndex({ c: 1 }, { unique: true, name: 'correo_unico' });

if (bd.clientas.countDocuments() === 0) {
  bd.clientas.insertMany([
    { id: 1, n: 'sofia reyes', c: 'sofiareyes@correo.com',   t: '6671234567' },
    { id: 2, n: 'josselyn angulo',    c: 'josselyn.angulo@correo.com',   t: '6679876543' },
    { id: 3, n: 'Anethzy Beltrán',        c: 'anethzy.beltran@correo.com', t: '6675554433' }
  ]);
  print('Se insertaron 3 clientas.');
} else {
  print('clientas ya tiene ' + bd.clientas.countDocuments() + ' documentos, no se insertó nada.');
}

if (bd.servicios.countDocuments() === 0) {
  bd.servicios.insertMany([
    { id: 1, n: 'Pestañas', p: 450, d: 90 }, { id: 2, n: 'Uñas', p: 350, d: 60 },
    { id: 3, n: 'Pedicura', p: 400, d: 60 }, { id: 4, n: 'Maquillaje', p: 700, d: 75 },
    { id: 5, n: 'Peinado', p: 500, d: 60 },  { id: 6, n: 'Cejas', p: 250, d: 30 }
  ]);
}

print('Listo. Colecciones: ' + bd.getCollectionNames().join(', '));