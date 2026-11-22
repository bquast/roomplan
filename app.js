// XRayRoom on Quest 3 — WebXR immersive-ar passthrough x-ray of a RoomPlan CAD model.
// Model coords = ARKit world of the iPhone scan (Y up, metres). Two floor points align it
// to the Quest local-floor space. Info and hidden services are generated demo data.

import * as THREE from './three.module.js';

const $ = id => document.getElementById(id);
const UP = new THREE.Vector3(0, 1, 0);

const COLORS = { wall: 0x40e6ff, door: 0xff9933, window: 0x8cccff, opening: 0xe6e6e6, floor: 0x4dff80,
	object: 0xd973ff, cold: 0x338cff, hot: 0xff4033, drain: 0xa6a6a6, gas: 0xffeb1a, light: 0xffff99, elec: 0xffb31a };
const FILL = { wall: 0.10, floor: 0.06, box: 0.6, object: 0.10 };
const EDGE = { wall: 0.006, box: 0.002, object: 0.004, floor: 0.004 };
const PRIO = { box: 0, pipe: 1, object: 2, wall: 4, floor: 5 };
const LAYERS = ['All', 'Structure', 'Services'];

const color = e => COLORS[e.kind] ?? COLORS[e.cat] ?? COLORS.elec;
const v3 = a => new THREE.Vector3(a[0], a[1], a[2]);
const ang = v => Math.atan2(-v.z, v.x);
const rotY = (v, a) => new THREE.Vector3(v.x * Math.cos(a) + v.z * Math.sin(a), v.y, -v.x * Math.sin(a) + v.z * Math.cos(a));

// ---- materials and geometry ----

const mats = new Map();
function mat(c, op) {
	const k = c + ':' + op;
	if (!mats.has(k))
		mats.set(k, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: op,
			depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
	return mats.get(k);
}
const HL = new THREE.MeshBasicMaterial({ color: 0xffff33, transparent: true, depthTest: false, depthWrite: false });
const PROXY = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false });
const BASE = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).toNonIndexed().attributes.position.array;

// many segments as one merged tube geometry
function tubes(segs, r) {
	const out = new Float32Array(BASE.length * segs.length);
	const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3();
	segs.forEach(([a, b], s) => {
		const d = new THREE.Vector3().subVectors(b, a);
		const len = Math.max(d.length(), 1e-4);
		q.setFromUnitVectors(UP, d.normalize());
		m.compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(r, len, r));
		for (let i = 0; i < BASE.length; i += 3) {
			v.set(BASE[i], BASE[i + 1], BASE[i + 2]).applyMatrix4(m);
			out[s * BASE.length + i] = v.x;
			out[s * BASE.length + i + 1] = v.y;
			out[s * BASE.length + i + 2] = v.z;
		}
	});
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(out, 3));
	g.computeBoundingSphere();
	return g;
}

// ear clipping: RoomPlan floors are often L-shaped (not convex)
function fan(cs) {
	const pos = [], flatZ = cs.every(c => Math.abs(c.z) < 1e-3);
	cs.forEach(c => pos.push(c.x, c.y, c.z));
	const c2 = cs.map(c => new THREE.Vector2(c.x, flatZ ? c.y : c.z));
	const idx = THREE.ShapeUtils.triangulateShape(c2, []).flat();
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	g.setIndex(idx);
	g.computeBoundingSphere();
	return g;
}

function corners(e) {
	if (e.kind === 'object' || e.kind === 'box' || e.kind === 'pipe')
		return null;
	if (e.poly && e.poly.length >= 9) {
		const p = [];
		for (let i = 0; i + 2 < e.poly.length; i += 3)
			p.push(new THREE.Vector3(e.poly[i], e.poly[i + 1], e.poly[i + 2]));
		return p;
	}
	const w = e.w / 2, h = e.h / 2, d = (e.d || 0) / 2;
	const c = h > 0.005 ? [[-w, -h, 0], [w, -h, 0], [w, h, 0], [-w, h, 0]] : [[-w, 0, -d], [w, 0, -d], [w, 0, d], [-w, 0, d]];
	return c.map(v3);
}

function boxEdges(e) {
	const w = e.w / 2, h = e.h / 2, d = e.d / 2, c = [];
	for (let i = 0; i < 8; i++)
		c.push(new THREE.Vector3(i & 1 ? w : -w, i & 2 ? h : -h, i & 4 ? d : -d));
	const E = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7], s = [];
	for (let i = 0; i < 24; i += 2)
		s.push([c[E[i]], c[E[i + 1]]]);
	return s;
}

// ---- scene ----

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const BG = new THREE.Color(0x05090e);
scene.background = BG;
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.02, 100);
const world = new THREE.Group();     // alignment: model -> real room
scene.add(world);

let els = [], picks = [], nodes = [], edgeMeshes = [], model = null;
let floorY = 0, center = new THREE.Vector3(), refs = [], refIdx = 0, cadSegs = [], size = 5, layer = 0;
const al = { x: 0, y: 0, z: 0, yaw: 0 };

function applyAlign() {
	world.position.set(al.x, al.y, al.z);
	world.rotation.set(0, al.yaw, 0);
}

function buildModel(list) {
	const g = new THREE.Group();
	els = list; picks = []; nodes = []; edgeMeshes = [];
	list.forEach((e, i) => {
		const c = color(e), node = new THREE.Group();
		node.userData.i = i;
		let edge;
		if (e.kind === 'pipe') {
			const a = v3(e.a), b = v3(e.b);
			edge = new THREE.Mesh(tubes([[a, b]], e.r), mat(c, 0.95));
			edge.renderOrder = 3;
			const px = new THREE.Mesh(tubes([[a, b]], 0.05), PROXY);
			px.userData.i = i;
			picks.push(px);
			node.add(edge, px);
		} else {
			node.matrixAutoUpdate = false;
			node.matrix.fromArray(e.t);
			const cs = corners(e);
			let fill, segs = [];
			if (cs) {
				fill = new THREE.Mesh(fan(cs), mat(c, FILL[e.kind] ?? 0.18));
				cs.forEach((p, j) => segs.push([p, cs[(j + 1) % cs.length]]));
			} else {
				fill = new THREE.Mesh(new THREE.BoxGeometry(e.w || 1e-3, e.h || 1e-3, e.d || 1e-3), mat(c, FILL[e.kind] ?? 0.18));
				segs = boxEdges(e);
			}
			edge = new THREE.Mesh(tubes(segs, EDGE[e.kind] ?? 0.005), mat(c, 0.95));
			fill.renderOrder = 1;
			edge.renderOrder = 2;
			fill.userData.i = i;
			picks.push(fill);
			node.add(fill, edge);
		}
		if (e.segs && e.segs.length >= 6) {
			const s = [];
			for (let j = 0; j + 5 < e.segs.length; j += 6)
				s.push([v3(e.segs.slice(j, j + 3)), v3(e.segs.slice(j + 3, j + 6))]);
			const st = new THREE.Mesh(tubes(s, 0.003), mat(COLORS.wall, 0.35));
			st.renderOrder = 1;
			g.add(st);
		}
		edge.userData.mat = edge.material;
		g.add(node);
		nodes.push(node);
		edgeMeshes.push(edge);
	});

	// floor, centre, and straight wall lines as alignment references
	const walls = list.filter(e => e.kind === 'wall');
	floorY = Infinity;
	center.set(0, 0, 0);
	for (const w of walls) {
		const p = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(w.t));
		floorY = Math.min(floorY, p.y - w.h / 2);
		center.add(p);
	}
	if (walls.length)
		center.divideScalar(walls.length);
	if (!isFinite(floorY))
		floorY = 0;
	center.y = floorY;
	refs = wallLines(walls);
	refIdx = 0;
	cadSegs = walls.map(w => {
		const T = new THREE.Matrix4().fromArray(w.t);
		const a = new THREE.Vector3(-w.w / 2, 0, 0).applyMatrix4(T), b = new THREE.Vector3(w.w / 2, 0, 0).applyMatrix4(T);
		return [a.x, a.z, b.x, b.z];
	});
	const bb = new THREE.Box3().setFromObject(g);
	size = Math.max(1, bb.max.x - bb.min.x, bb.max.z - bb.min.z);
	return g;
}

// RoomPlan splits one physical wall into parts (at stairs, corners of niches).
// Merge collinear parts (5 deg, 15 cm, gaps < 1.2 m) into straight lines, longest first.
function wallLines(walls) {
	const runs = [], ends = [];
	walls.forEach((w, i) => {
		const T = new THREE.Matrix4().fromArray(w.t);
		for (const x of [-w.w / 2, w.w / 2]) {
			const e = new THREE.Vector3(x, 0, 0).applyMatrix4(T);
			ends.push({ i, x: e.x, z: e.z });
		}
	});
	walls.forEach((w, wi) => {
		const T = new THREE.Matrix4().fromArray(w.t);
		const a = new THREE.Vector3(-w.w / 2, 0, 0).applyMatrix4(T), b = new THREE.Vector3(w.w / 2, 0, 0).applyMatrix4(T);
		const d = new THREE.Vector2(b.x - a.x, b.z - a.z).normalize();
		if (d.x < -1e-6 || (Math.abs(d.x) < 1e-6 && d.y < 0))
			d.negate();
		const n = new THREE.Vector2(-d.y, d.x);
		const off = n.x * a.x + n.y * a.z;
		const t0 = d.x * a.x + d.y * a.z, t1 = d.x * b.x + d.y * b.z;
		let g = runs.find(g => g.d.dot(d) > 0.996 && Math.abs(g.off - off) < 0.15);
		if (!g)
			runs.push(g = { d, n, off, iv: [], m: new Set() });
		g.iv.push([Math.min(t0, t1), Math.max(t0, t1)]);
		g.m.add(wi);
	});
	// a wall of another line ending at the joint = T-junction or niche: do not merge there
	const blocked = (g, t0, t1) => ends.some(e => !g.m.has(e.i) &&
		Math.abs(g.n.x * e.x + g.n.y * e.z - g.off) < 0.2 &&
		(g.d.x * e.x + g.d.y * e.z) > t0 - 0.2 && (g.d.x * e.x + g.d.y * e.z) < t1 + 0.2);
	const lines = [];
	for (const g of runs) {
		g.iv.sort((p, q) => p[0] - q[0]);
		const P = t => new THREE.Vector3(g.n.x * g.off + g.d.x * t, floorY, g.n.y * g.off + g.d.y * t);
		let cur = g.iv[0].slice();
		const flush = () => lines.push({ a: P(cur[0]), b: P(cur[1]), len: cur[1] - cur[0] });
		for (const iv of g.iv.slice(1)) {
			if (iv[0] <= cur[1] + 1.2 && !blocked(g, cur[1], iv[0])) cur[1] = Math.max(cur[1], iv[1]);
			else { flush(); cur = iv.slice(); }
		}
		flush();
	}
	return lines.filter(l => l.len >= 1).sort((p, q) => q.len - p.len);
}

function setModel(list, name) {
	if (!Array.isArray(list) || !list.length) {
		$('msg').textContent = 'This is not a model.json from the XRayRoom iPhone app.';
		return;
	}
	if (model)
		world.remove(model);
	model = buildModel(list);
	world.add(model);
	layer = 0;
	applyLayer();
	desktopAlign();
	const n = k => list.filter(e => e.kind === k).length;
	$('msg').textContent = `${name}: ${n('wall')} walls, ${n('object')} objects, ${n('pipe') + n('box')} services.`;
}

function desktopAlign() {
	Object.assign(al, { x: -center.x, y: -floorY, z: -center.z, yaw: 0 });
	applyAlign();
	world.visible = true;
}

function applyLayer() {
	nodes.forEach((n, i) => {
		const k = els[i].kind;
		n.visible = !(layer === 1 && (k === 'pipe' || k === 'box')) &&
			!(layer === 2 && ['object', 'door', 'window', 'opening'].includes(k));
	});
}

// ---- info panel (canvas texture) ----

const pc = document.createElement('canvas');
pc.width = 1024; pc.height = 640;
const pctx = pc.getContext('2d');
const ptex = new THREE.CanvasTexture(pc);
ptex.colorSpace = THREE.SRGBColorSpace;
const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.3),
	new THREE.MeshBasicMaterial({ map: ptex, transparent: true, depthTest: false, depthWrite: false }));
panel.renderOrder = 10;
panel.visible = false;
scene.add(panel);

function wrap(text, max) {
	const out = [];
	let line = '';
	for (const w of text.split(' ')) {
		const t = line ? line + ' ' + w : w;
		if (pctx.measureText(t).width > max && line) { out.push(line); line = w; } else line = t;
	}
	if (line) out.push(line);
	return out;
}

function drawPanel(tag, title, lines, accent = '#40e6ff') {
	const c = pctx;
	c.clearRect(0, 0, 1024, 640);
	c.fillStyle = 'rgba(6, 14, 24, 0.9)';
	c.strokeStyle = accent;
	c.lineWidth = 6;
	c.beginPath();
	c.roundRect(6, 6, 1012, 628, 36);
	c.fill();
	c.stroke();
	let y = 70;
	c.fillStyle = '#ffd633';
	c.font = 'bold 30px system-ui, sans-serif';
	c.fillText(tag, 44, y);
	c.fillStyle = '#ffffff';
	c.font = 'bold 50px system-ui, sans-serif';
	for (const l of wrap(title, 940)) { y += 62; c.fillText(l, 44, y); }
	y += 14;
	c.fillStyle = '#d8f4ff';
	c.font = '34px ui-monospace, Menlo, monospace';
	for (const s of lines)
		for (const l of wrap(s, 940)) {
			y += 46;
			if (y < 620) c.fillText(l, 44, y);
		}
	ptex.needsUpdate = true;
}

function placePanel(at, eye, dist) {
	const s = THREE.MathUtils.clamp(dist / 1.2, 0.8, 3);
	const toEye = new THREE.Vector3().subVectors(eye, at).normalize();
	panel.position.copy(at).addScaledVector(toEye, Math.min(0.3, dist * 0.3)).addScaledVector(UP, 0.18 * s);
	panel.scale.setScalar(s);
	panel.lookAt(eye);
	panel.visible = true;
}

// ---- effects ----

let actx = null;
function audio() {
	if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
	if (actx.state === 'suspended') actx.resume();
}
function pew() {
	if (!actx) return;
	const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
	o.type = 'triangle';
	o.frequency.setValueAtTime(2400, t);
	o.frequency.exponentialRampToValueAtTime(260, t + 0.16);
	g.gain.setValueAtTime(0.35, t);
	g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
	o.connect(g).connect(actx.destination);
	o.start(t);
	o.stop(t + 0.22);
}

const fx = [];
function laser(o, p) {
	const m = new THREE.Mesh(tubes([[o, p]], 0.003),
		new THREE.MeshBasicMaterial({ color: 0xff3020, transparent: true, depthTest: false, depthWrite: false }));
	m.renderOrder = 9;
	scene.add(m);
	fx.push({ m, t: 0, life: 0.3, grow: 0 });
	const s = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8),
		new THREE.MeshBasicMaterial({ color: 0xffee66, transparent: true, depthTest: false, depthWrite: false }));
	s.position.copy(p);
	s.renderOrder = 9;
	scene.add(s);
	fx.push({ m: s, t: 0, life: 0.4, grow: 4 });
}
function updateFx(dt) {
	for (let i = fx.length - 1; i >= 0; i--) {
		const f = fx[i];
		f.t += dt;
		const k = f.t / f.life;
		f.m.material.opacity = Math.max(0, 1 - k);
		if (f.grow) f.m.scale.setScalar(1 + f.grow * k);
		if (k >= 1) {
			scene.remove(f.m);
			f.m.geometry.dispose();
			f.m.material.dispose();
			fx.splice(i, 1);
		}
	}
}

let hl = -1, hlTok = 0;
function highlight(i) {
	if (hl >= 0) edgeMeshes[hl].material = edgeMeshes[hl].userData.mat;
	hl = i;
	edgeMeshes[i].material = HL;
	const tok = ++hlTok;
	setTimeout(() => {
		if (tok === hlTok && hl >= 0) { edgeMeshes[hl].material = edgeMeshes[hl].userData.mat; hl = -1; }
	}, 2500);
}

// ---- picking ----

const ray = new THREE.Raycaster();
ray.far = 25;

function shown(o) {
	for (; o; o = o.parent)
		if (!o.visible) return false;
	return true;
}

function pick(o, d) {
	ray.set(o, d);
	let best = null, bp = 99;
	for (const h of ray.intersectObjects(picks, false)) {
		if (!shown(h.object)) continue;
		const p = PRIO[els[h.object.userData.i].kind] ?? 3;
		if (p < bp) { bp = p; best = h; }
	}
	return best;
}

function shoot(o, d, eye, src) {
	const h = pick(o, d);
	const end = h ? h.point : o.clone().addScaledVector(d, 6);
	laser(o.clone().addScaledVector(d, 0.05), end);
	pew();
	src?.gamepad?.hapticActuators?.[0]?.pulse?.(0.6, 50);
	if (!h) return;
	const i = h.object.userData.i, e = els[i], dist = eye.distanceTo(h.point);
	drawPanel('DEMO DATA · GENERATED', e.title || e.kind, [...(e.info || []), `Range: ${dist.toFixed(2)} m`], '#' + color(e).toString(16).padStart(6, '0'));
	placePanel(h.point, eye, dist);
	highlight(i);
}

// ---- XR: controllers, alignment ----

let state = 'desktop', needMini = false, mini = null, clicks = [], order = null, curFrame = null, liveT = 0;
const marks = [];
const reticle = new THREE.Mesh(new THREE.SphereGeometry(0.01, 12, 8),
	new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, transparent: true }));
reticle.renderOrder = 11;
reticle.visible = false;
scene.add(reticle);

const ctrls = [0, 1].map(i => {
	const c = renderer.xr.getController(i);
	const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
		new THREE.LineBasicMaterial({ color: 0x80f0ff, transparent: true, opacity: 0.7, depthTest: false }));
	line.renderOrder = 11;
	c.add(line);
	c.userData.line = line;
	c.userData.prev = [];
	c.addEventListener('connected', e => {
		c.userData.src = e.data;
		const s = renderer.xr.getSession();     // hit-test against the Quest room mesh, if granted
		if (s?.requestHitTestSource && e.data.targetRaySpace)
			s.requestHitTestSource({ space: e.data.targetRaySpace }).then(h => { c.userData.hts = h; }).catch(() => {});
	});
	c.addEventListener('disconnected', () => {
		c.userData.src = null;
		c.userData.hts?.cancel?.();
		c.userData.hts = null;
	});
	c.addEventListener('selectstart', () => trigger(c));
	c.addEventListener('squeezestart', () => { panel.visible = false; });
	scene.add(c);
	return c;
});

function ctrlRay(c) {
	c.updateMatrixWorld(true);
	const o = new THREE.Vector3().setFromMatrixPosition(c.matrixWorld);
	const d = new THREE.Vector3(0, 0, -1).transformDirection(c.matrixWorld);
	return [o, d];
}

function floorHit(o, d) {
	if (d.y > -0.05) return null;
	return o.clone().addScaledVector(d, -o.y / d.y);
}

// alignment aim: real surface (walls, corners) via hit-test, else the local-floor plane
function aim(c, o, d) {
	const hts = c.userData.hts;
	if (hts && curFrame) {
		const res = curFrame.getHitTestResults(hts);
		const pose = res.length ? res[0].getPose(renderer.xr.getReferenceSpace()) : null;
		if (pose) {
			const p = pose.transform.position;
			return { p: new THREE.Vector3(p.x, p.y, p.z), mesh: true };
		}
	}
	const f = floorHit(o, d);
	return f ? { p: f, mesh: false } : null;
}

function eyePose() {
	const xc = renderer.xr.getCamera();
	const p = new THREE.Vector3().setFromMatrixPosition(xc.matrixWorld);
	const f = new THREE.Vector3(0, 0, -1).transformDirection(xc.matrixWorld);
	f.y = 0;
	if (f.lengthSq() < 1e-4) f.set(0, 0, -1);
	return [p, f.normalize()];
}

function startAlign() {
	state = 'align1';
	needMini = true;
	world.visible = false;
	clicks = [];
	marks.forEach(m => scene.remove(m));
	marks.length = 0;
	panel.visible = false;
}

function showMini() {
	if (mini) scene.remove(mini);
	const [p, f] = eyePose();
	if (!refs.length) {   // no walls: just put the model where the user stands
		Object.assign(al, { x: p.x - center.x, y: -floorY, z: p.z - center.z, yaw: 0 });
		applyAlign();
		world.visible = true;
		state = 'xray';
		return;
	}
	const s = 0.45 / size, ref = [refs[refIdx].a, refs[refIdx].b];
	const wallMid = ref[0].clone().add(ref[1]).multiplyScalar(0.5);
	const d = wallMid.clone().sub(center);
	const yaw = ang(f) - ang(d);
	mini = new THREE.Group();
	const inner = new THREE.Group();
	inner.position.copy(center).negate();
	inner.add(model.clone());
	// left / right corner as the user sees it
	const r = new THREE.Vector3(-f.z, 0, f.x);
	const a = rotY(ref[0].clone().sub(center), yaw).dot(r), b = rotY(ref[1].clone().sub(center), yaw).dot(r);
	order = a < b ? [ref[0], ref[1]] : [ref[1], ref[0]];
	const dot = (q, c) => {
		const m = new THREE.Mesh(new THREE.SphereGeometry(0.014 / s, 16, 10),
			new THREE.MeshBasicMaterial({ color: c, depthTest: false, depthWrite: false }));
		m.position.copy(q);
		m.renderOrder = 12;
		inner.add(m);
	};
	dot(order[0], 0x33ff66);
	dot(order[1], 0xff3344);
	// corner posts: the corner can be picked at any height
	const post = (q, c) => {
		const m = new THREE.Mesh(tubes([[q, q.clone().setY(q.y + 2.6)]], 0.005 / s),
			new THREE.MeshBasicMaterial({ color: c, depthTest: false, depthWrite: false }));
		m.renderOrder = 12;
		inner.add(m);
	};
	post(order[0], 0x33ff66);
	post(order[1], 0xff3344);
	const edge = new THREE.Mesh(tubes([[order[0], order[1]]], 0.006 / s), HL);
	edge.renderOrder = 12;
	inner.add(edge);
	mini.add(inner);
	mini.scale.setScalar(s);
	mini.rotation.y = yaw;
	mini.position.copy(p).addScaledVector(f, 0.7);
	mini.position.y = p.y - 0.45;
	scene.add(mini);
	alignText();
}

function alignText(live) {
	const step = clicks.length, ref = refs[refIdx];
	const lines = [step === 0 ? '→ Aim at its LEFT end (green post), the corner with the next wall. Any height. Trigger.'
			: '→ Now aim at its RIGHT end (red post). Trigger.',
		`Wall line ${refIdx + 1} of ${refs.length}: ${ref.len.toFixed(2)} m · right stick ←/→: other wall`];
	if (live)
		lines.push(live);
	drawPanel('ALIGN · STEP ' + (step + 1) + ' OF 2', 'Face the yellow wall in the real room', lines,
		step === 0 ? '#33ff66' : '#ff3344');
	if (live)
		return;
	const [p] = eyePose();
	placePanel(mini.position.clone().add(new THREE.Vector3(0, 0.22, 0)), p, 0.9);
	panel.scale.setScalar(1);
}

function solveAlign(a, b) {
	// rigid fit in the floor plane: direction from the two points, midpoint on midpoint
	const A = order[0], B = order[1];
	const yaw = ang(b.clone().sub(a)) - ang(B.clone().sub(A));
	const mA = rotY(A.clone().add(B).multiplyScalar(0.5), yaw), ma = a.clone().add(b).multiplyScalar(0.5);
	Object.assign(al, { x: ma.x - mA.x, y: -floorY, z: ma.z - mA.z, yaw });
	applyAlign();
	const real = Math.hypot(b.x - a.x, b.z - a.z), cad = Math.hypot(B.x - A.x, B.z - A.z);
	const bad = Math.abs(real - cad) > 0.08 * cad;
	if (mini) { scene.remove(mini); mini = null; }
	world.visible = true;
	state = 'xray';
	const [p] = eyePose();
	drawPanel('ALIGNED', 'X-ray on. Aim and pull the trigger.',
		[`Wall: CAD ${cad.toFixed(2)} m · your points ${real.toFixed(2)} m`,
		 bad ? '⚠ Lengths differ: wrong corner? Press A/X to align again.' : 'Lengths match.',
		 'Left stick: move · Right stick: rotate / height', 'A/X: align again · B/Y: layers · Grip: hide'],
		bad ? '#ffb31a' : '#40e6ff');
	placePanel(p.clone().add(new THREE.Vector3(0, -0.1, 0)).addScaledVector(eyePose()[1], 1.0), p, 1);
	panel.scale.setScalar(1);
	if (!bad)
		setTimeout(() => { if (state === 'xray') startFit(); }, 2500);
}

function trigger(c) {
	audio();
	const [o, d] = ctrlRay(c);
	const src = c.userData.src;
	if (state === 'align1' || state === 'align2') {
		const h = c.userData.aim?.p;
		if (!h || !mini) return;
		src?.gamepad?.hapticActuators?.[0]?.pulse?.(0.4, 30);
		pew();
		const m = new THREE.Mesh(new THREE.RingGeometry(0.04, 0.06, 24),
			new THREE.MeshBasicMaterial({ color: clicks.length ? 0xff3344 : 0x33ff66, side: THREE.DoubleSide, depthTest: false }));
		m.rotation.x = -Math.PI / 2;
		m.position.set(h.x, 0.002, h.z);
		m.renderOrder = 12;
		scene.add(m);
		marks.push(m);
		clicks.push(h.clone());
		if (clicks.length === 1) { state = 'align2'; alignText(); }
		else solveAlign(clicks[0], clicks[1]);
	} else if (state === 'xray') {
		shoot(o, d, eyePose()[0], src);
	}
}

function xrUpdate(dt) {
	if (needMini) { needMini = false; showMini(); }
	if (fit) fitUpdate(dt);
	const [eye, f] = eyePose();
	const r = new THREE.Vector3(-f.z, 0, f.x);
	reticle.visible = false;
	for (const c of ctrls) {
		const src = c.userData.src;
		c.userData.line.visible = !!src;
		if (!src) continue;
		const [o, d] = ctrlRay(c);
		let len = 5, at = null;
		if (state === 'xray') {
			const h = pick(o, d);
			if (h) { len = h.distance; at = h.point; }
		} else if (state.startsWith('align')) {
			const h = c.userData.aim = aim(c, o, d);
			if (h) {
				at = h.p;
				len = o.distanceTo(at);
				reticle.material.color.set(h.mesh ? 0x40e6ff : 0xffffff);
			}
			if (h && state === 'align2' && (liveT += dt) > 0.2) {
				liveT = 0;
				const a = clicks[0];
				alignText(`Span now: ${Math.hypot(h.p.x - a.x, h.p.z - a.z).toFixed(2)} m (CAD ${refs[refIdx].len.toFixed(2)} m)`);
			}
		}
		c.userData.line.scale.z = len;
		if (at) {
			reticle.position.copy(at);
			reticle.scale.setScalar(Math.max(1, eye.distanceTo(at)));
			reticle.visible = true;
		}
		const gp = src.gamepad;
		if (!gp) continue;
		const prev = c.userData.prev, btn = k => gp.buttons[k]?.pressed && !prev[k];
		if (btn(4)) { endFit(true); startAlign(); }
		if (btn(3) && state === 'xray') startFit();
		if (btn(5) && state === 'xray') {
			layer = (layer + 1) % 3;
			applyLayer();
			drawPanel('LAYER', LAYERS[layer], [['Everything', 'Walls, openings, furniture', 'Pipes, wiring, outlets, studs'][layer]]);
			placePanel(eye.clone().addScaledVector(f, 1.0).add(new THREE.Vector3(0, -0.15, 0)), eye, 1);
			panel.scale.setScalar(1);
		}
		c.userData.prev = gp.buttons.map(b => b.pressed);
		const ax = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0] || 0;
		const ay = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1] || 0;
		if (state.startsWith('align') && src.handedness === 'right' && refs.length > 1) {
			if (Math.abs(ax) > 0.7 && !c.userData.flick) {
				c.userData.flick = true;
				refIdx = (refIdx + (ax > 0 ? 1 : refs.length - 1)) % refs.length;
				startAlign();
			}
			if (Math.abs(ax) < 0.3)
				c.userData.flick = false;
		}
		if (state !== 'xray') continue;
		const dz = v => Math.abs(v) < 0.15 ? 0 : v;
		if (src.handedness === 'left') {
			const m = r.clone().multiplyScalar(dz(ax)).addScaledVector(f, -dz(ay)).multiplyScalar(0.4 * dt);
			al.x += m.x;
			al.z += m.z;
		} else {
			const dy = -dz(ax) * 0.5 * dt;
			if (dy) {
				const pv = world.localToWorld(center.clone());
				const t = rotY(new THREE.Vector3(al.x - pv.x, 0, al.z - pv.z), dy);
				al.x = pv.x + t.x;
				al.z = pv.z + t.z;
				al.yaw += dy;
			}
			al.y -= dz(ay) * 0.15 * dt;
		}
		applyAlign();
	}
}

// ---- auto-fit: refine yaw and position with Quest hit-test points on the real walls ----
// Gaze hit-test (viewer space) collects points at chest-to-head height; 2D point-to-line ICP
// against the CAD walls, damped, small steps. Starts after the two-point alignment.

let fit = null;
const FITMAX = 600;
const dots = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(FITMAX * 3), 3)),
	new THREE.PointsMaterial({ color: 0x4dff80, size: 0.025, depthTest: false, transparent: true }));
dots.renderOrder = 12;
dots.frustumCulled = false;
dots.visible = false;
scene.add(dots);

function startFit() {
	const s = renderer.xr.getSession();
	endFit(true);
	if (!s?.requestHitTestSource || !cadSegs.length) {
		drawPanel('AUTO-FIT', 'Not available', ['Needs WebXR hit-test (Quest Space Setup) and walls in the scan.']);
		return;
	}
	fit = { pts: [], t: 0, age: 0, rms: 0, inl: 0, move: 1, src: null, txt: 0 };
	const f = fit;
	s.requestReferenceSpace('viewer').then(vs => s.requestHitTestSource({ space: vs }))
		.then(h => { if (fit === f) f.src = h; else h.cancel(); }).catch(() => { if (fit === f) fit = null; });
	dots.visible = true;
	dots.geometry.setDrawRange(0, 0);
	const [eye, fw] = eyePose();
	fitText();
	placePanel(eye.clone().addScaledVector(fw, 1.1).add(new THREE.Vector3(0, -0.3, 0)), eye, 1.1);
	panel.scale.setScalar(1);
}

function endFit(quiet) {
	if (!fit) return;
	fit.src?.cancel?.();
	const f = fit;
	fit = null;
	setTimeout(() => { if (!fit) dots.visible = false; }, 3000);
	if (!quiet)
		drawPanel('AUTO-FIT DONE', f.inl ? `Wall error ${(f.rms * 100).toFixed(1)} cm` : 'No wall points found',
			[`${f.inl} of ${f.pts.length} points on CAD walls`, 'Thumbstick press: run again · A/X: align again']);
}

function fitText() {
	drawPanel('AUTO-FIT · ' + Math.max(0, 30 - (fit?.age || 0)).toFixed(0) + ' s', 'Look around at the walls',
		['Slowly, at chest to head height. Green dots = Quest hits.',
		 `Points: ${fit?.pts.length || 0} · on CAD walls: ${fit?.inl || 0}`,
		 fit?.inl ? `Wall error (RMS): ${(fit.rms * 100).toFixed(1)} cm` : 'Waiting for points…'], '#4dff80');
}

function icpStep() {
	world.updateMatrixWorld(true);
	const W = world.matrixWorld;
	const segs = cadSegs.map(s => [new THREE.Vector3(s[0], 0, s[1]).applyMatrix4(W), new THREE.Vector3(s[2], 0, s[3]).applyMatrix4(W)]);
	const c = world.localToWorld(center.clone());
	const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0];
	const thr = fit.age < 8 ? 0.5 : 0.3;
	let n = 0, sq = 0;
	for (const q of fit.pts) {
		let best = null, bd = thr;
		for (const [a, b] of segs) {
			const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
			if (L2 < 1e-4) continue;
			const t = ((q.x - a.x) * dx + (q.z - a.z) * dz) / L2;
			if (t < -0.05 || t > 1.05) continue;
			const tc = Math.min(1, Math.max(0, t)), px = a.x + tc * dx, pz = a.z + tc * dz;
			const d = Math.hypot(q.x - px, q.z - pz);
			if (d < bd) {
				const L = Math.sqrt(L2);
				bd = d;
				best = { px, pz, nx: -dz / L, nz: dx / L };
			}
		}
		if (!best) continue;
		const r = (q.x - best.px) * best.nx + (q.z - best.pz) * best.nz;
		const J = [(best.pz - c.z) * best.nx - (best.px - c.x) * best.nz, best.nx, best.nz];
		for (let i = 0; i < 3; i++) {
			B[i] += J[i] * r;
			for (let j = 0; j < 3; j++) A[i][j] += J[i] * J[j];
		}
		n++;
		sq += r * r;
	}
	fit.inl = n;
	fit.rms = n ? Math.sqrt(sq / n) : 0;
	if (n < 20) return;
	for (let i = 0; i < 3; i++) A[i][i] += 0.05 * n;      // damping: keeps unseen directions still
	const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
		+ m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
	const D = det(A);
	if (Math.abs(D) < 1e-9) return;
	const x = [0, 1, 2].map(k => det(A.map((row, i) => row.map((v, j) => j === k ? B[i] : v))) / D);
	const th = Math.max(-0.05, Math.min(0.05, x[0]));
	let tx = x[1], tz = x[2];
	const tl = Math.hypot(tx, tz);
	if (tl > 0.15) { tx *= 0.15 / tl; tz *= 0.15 / tl; }
	const rp = rotY(new THREE.Vector3(al.x - c.x, 0, al.z - c.z), th);
	al.x = c.x + rp.x + tx;
	al.z = c.z + rp.z + tz;
	al.yaw += th;
	applyAlign();
	fit.move = Math.hypot(tx, tz) + Math.abs(th) * 3;
}

function fitUpdate(dt) {
	fit.age += dt;
	if (fit.src && curFrame) {
		const res = curFrame.getHitTestResults(fit.src);
		const pose = res.length ? res[0].getPose(renderer.xr.getReferenceSpace()) : null;
		if (pose) {
			const p = pose.transform.position, v = new THREE.Vector3(p.x, p.y, p.z);
			const last = fit.pts[fit.pts.length - 1];
			if (p.y > 0.9 && p.y < 2.2 && (!last || last.distanceTo(v) > 0.05)) {
				fit.pts.push(v);
				if (fit.pts.length > FITMAX) fit.pts.shift();
				const arr = dots.geometry.attributes.position.array;
				fit.pts.forEach((q, i) => { arr[3 * i] = q.x; arr[3 * i + 1] = q.y; arr[3 * i + 2] = q.z; });
				dots.geometry.attributes.position.needsUpdate = true;
				dots.geometry.setDrawRange(0, fit.pts.length);
			}
		}
	}
	if ((fit.t += dt) > 0.3 && fit.pts.length >= 30) {
		fit.t = 0;
		icpStep();
	}
	if ((fit.txt += dt) > 0.5) {
		fit.txt = 0;
		fitText();
	}
	if (fit.age > 30 || (fit.age > 12 && fit.inl > 150 && fit.rms < 0.025 && fit.move < 0.003))
		endFit(false);
}

renderer.xr.addEventListener('sessionstart', () => {
	scene.background = null;
	renderer.setClearColor(0x000000, 0);
	$('ui').style.display = 'none';
	startAlign();
});
renderer.xr.addEventListener('sessionend', () => {
	scene.background = BG;
	$('ui').style.display = '';
	if (mini) { scene.remove(mini); mini = null; }
	marks.forEach(m => scene.remove(m));
	endFit(true);
	state = 'desktop';
	panel.visible = false;
	desktopAlign();
});

// ---- desktop preview: drag to orbit, wheel to zoom, click to shoot ----

const orb = { az: 0.6, el: 0.6, dist: 9 };
let drag = null;
renderer.domElement.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, moved: 0 }; });
addEventListener('pointermove', e => {
	if (!drag) return;
	const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
	drag.moved += Math.abs(dx) + Math.abs(dy);
	drag.x = e.clientX; drag.y = e.clientY;
	orb.az -= dx * 0.005;
	orb.el = THREE.MathUtils.clamp(orb.el + dy * 0.005, 0.05, 1.5);
});
addEventListener('pointerup', e => {
	if (drag && drag.moved < 5 && state === 'desktop') {
		audio();
		const n = new THREE.Vector2(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
		ray.setFromCamera(n, camera);
		shoot(camera.position.clone().add(new THREE.Vector3(0, -0.2, 0)), ray.ray.direction.clone(), camera.position.clone(), null);
	}
	drag = null;
});
renderer.domElement.addEventListener('wheel', e => { orb.dist = THREE.MathUtils.clamp(orb.dist * (1 + e.deltaY * 0.001), 1.5, 40); });
addEventListener('resize', () => {
	camera.aspect = innerWidth / innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize(innerWidth, innerHeight);
});

function desktopUpdate() {
	camera.position.set(Math.sin(orb.az) * Math.cos(orb.el), Math.sin(orb.el), Math.cos(orb.az) * Math.cos(orb.el))
		.multiplyScalar(orb.dist).add(new THREE.Vector3(0, 1.2, 0));
	camera.lookAt(0, 1.2, 0);
}

let last = performance.now();
renderer.setAnimationLoop((t, frame) => {
	curFrame = frame || null;
	const dt = Math.min(0.1, (t - last) / 1000);
	last = t;
	if (renderer.xr.isPresenting) xrUpdate(dt); else desktopUpdate();
	updateFx(dt);
	renderer.render(scene, camera);
});

// ---- loading ----

async function load(url) {
	try {
		const r = await fetch(url);
		setModel(await r.json(), url.split('/').pop());
	} catch (err) {
		$('msg').textContent = 'Cannot load ' + url + ': ' + err.message;
	}
}

$('file').addEventListener('change', e => {
	const f = e.target.files[0];
	if (!f) return;
	f.text().then(t => {
		try { setModel(JSON.parse(t), f.name); } catch (err) { $('msg').textContent = 'Bad JSON: ' + err.message; }
	});
});

$('ar').addEventListener('click', async () => {
	audio();
	try {
		const s = await navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['local-floor'], optionalFeatures: ['hit-test'] });
		await renderer.xr.setSession(s);
	} catch (err) {
		$('msg').textContent = 'AR failed: ' + err.message;
	}
});

if (navigator.xr)
	navigator.xr.isSessionSupported('immersive-ar').then(ok => {
		$('ar').disabled = !ok;
		if (!ok) $('ar').textContent = 'AR needs Quest Browser';
	});
else
	$('ar').textContent = 'No WebXR here';

$('scan').addEventListener('change', e => load(e.target.value));
const q = new URLSearchParams(location.search).get('scan');
if (q) $('scan').value = q;
load(q || $('scan').value);
