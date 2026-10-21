import {Vector3} from 'three';

const finite3 = x => Array.isArray(x) && x.length === 3 && x.every(Number.isFinite);
function positive(x, name) {
  if (!Number.isFinite(x) || x <= 0) throw new Error(`${name} must be finite and positive`);
}

/** Read a visible mesh vertex or a rigid local anchor after evaluating the real pose. */
export function worldAnchor(anchor, target = new Vector3()) {
  const o = anchor?.object;
  if (!o?.isObject3D) throw new Error('Anchor needs a live Object3D');
  const vertex = anchor.vertex !== undefined;
  if (vertex === (anchor.local !== undefined)) throw new Error('Choose vertex OR local anchor');
  o.updateWorldMatrix(true, false);
  if (vertex) {
    const count = o.geometry?.attributes.position?.count;
    if (!o.isMesh || !Number.isInteger(anchor.vertex) || anchor.vertex < 0 || anchor.vertex >= count)
      throw new Error('Anchor vertex absent from the rendered mesh');
    o.getVertexPosition(anchor.vertex, target);
  } else {
    if (o.isSkinnedMesh) throw new Error('SkinnedMesh contacts require a deformed vertex');
    if (!finite3(anchor.local)) throw new Error('Local anchor needs three finite coordinates');
    target.fromArray(anchor.local);
  }
  target.applyMatrix4(o.matrixWorld);
  if (!finite3(target.toArray())) throw new Error('Nonfinite world anchor');
  return target;
}

export function measureContacts(contacts, time, {metresPerUnit = 1} = {}) {
  positive(metresPerUnit, 'metresPerUnit');
  if (!Number.isFinite(time) || !Array.isArray(contacts) || !contacts.length)
    throw new Error('Contacts and finite time required');
  const ids = new Set(), checks = [];
  for (const c of contacts) {
    if (!c.id || ids.has(c.id)) throw new Error('Contact IDs must be nonempty and unique');
    ids.add(c.id);
    if (!Array.isArray(c.interval) || c.interval.length !== 2 || !c.interval.every(Number.isFinite)
        || c.interval[0] < 0 || c.interval[1] < c.interval[0]) throw new Error('Invalid contact interval');
    positive(c.maxGapMetres, 'maxGapMetres');
    if (time < c.interval[0] || time > c.interval[1]) continue;
    const a = worldAnchor(c.a), b = worldAnchor(c.b);
    const gapMetres = a.distanceTo(b) * metresPerUnit;
    checks.push({name:`contact:${c.id}`, ok:gapMetres <= c.maxGapMetres,
      time, gapMetres, maxGapMetres:c.maxGapMetres});
  }
  return checks;
}

/** Diagnostic finite differences; caller supplies points in a stated reference frame. */
export function motionChecks(samples, {id, maxSpeed, maxAcceleration, metresPerUnit = 1}) {
  positive(metresPerUnit, 'metresPerUnit'); positive(maxSpeed, 'maxSpeed');
  positive(maxAcceleration, 'maxAcceleration');
  if (!id || !Array.isArray(samples) || samples.length < 3) throw new Error('Need ID and >=3 samples');
  const checks = []; let previousVelocity, previousMidpoint;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!Number.isFinite(s.time) || !finite3(s.position)) throw new Error('Nonfinite motion sample');
    if (!i) continue;
    const p = samples[i-1], dt = s.time-p.time;
    if (dt <= 0) throw new Error('Motion samples must have strictly increasing times');
    const velocity = new Vector3().fromArray(s.position).sub(new Vector3().fromArray(p.position)).multiplyScalar(metresPerUnit/dt);
    const speed = velocity.length(), midpoint = (s.time+p.time)/2;
    checks.push({name:`speed:${id}`, ok:speed <= maxSpeed, time:s.time, speed, maxSpeed});
    if (previousVelocity) {
      const acceleration = velocity.clone().sub(previousVelocity).length()/(midpoint-previousMidpoint);
      checks.push({name:`acceleration:${id}`, ok:acceleration <= maxAcceleration,
        time:p.time, acceleration, maxAcceleration});
    }
    previousVelocity = velocity; previousMidpoint = midpoint;
  }
  return checks;
}
