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
let floorY = 0, center = new THREE.Vector3(), ref = null, size = 5, layer = 0;
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

	// floor, centre and the longest wall as the alignment reference
	const walls = list.filter(e => e.kind === 'wall');
	floorY = Infinity;
	center.set(0, 0, 0);
	ref = null;
	let best = 0;
	for (const w of walls) {
		const T = new THREE.Matrix4().fromArray(w.t), p = new THREE.Vector3().setFromMatrixPosition(T);
		floorY = Math.min(floorY, p.y - w.h / 2);
		center.add(p);
		if (w.w > best) {
			best = w.w;
			ref = [new THREE.Vector3(-w.w / 2, -w.h / 2, 0).applyMatrix4(T), new THREE.Vector3(w.w / 2, -w.h / 2, 0).applyMatrix4(T)];
		}
	}
	if (walls.length)
		center.divideScalar(walls.length);
	if (!isFinite(floorY))
		floorY = 0;
	center.y = floorY;
	const bb = new THREE.Box3().setFromObject(g);
	size = Math.max(1, bb.max.x - bb.min.x, bb.max.z - bb.min.z);
	return g;
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

let state = 'desktop', needMini = false, mini = null, clicks = [], order = null;
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
	c.addEventListener('connected', e => { c.userData.src = e.data; });
	c.addEventListener('disconnected', () => { c.userData.src = null; });
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
	if (!ref) {           // no walls: just put the model where the user stands
		Object.assign(al, { x: p.x - center.x, y: -floorY, z: p.z - center.z, yaw: 0 });
		applyAlign();
		world.visible = true;
		state = 'xray';
		return;
	}
	const s = 0.45 / size;
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

function alignText() {
	const step = clicks.length;
	drawPanel('ALIGN · STEP ' + (step + 1) + ' OF 2', 'Face the yellow wall in the real room',
		[step === 0 ? '→ Point at the floor at its LEFT corner (green dot). Pull the trigger.'
			: '→ Now point at the floor at its RIGHT corner (red dot). Pull the trigger.',
		 'Tip: aim where the wall meets the floor.'], step === 0 ? '#33ff66' : '#ff3344');
	const [p] = eyePose();
	placePanel(mini.position.clone().add(new THREE.Vector3(0, 0.22, 0)), p, 0.9);
	panel.scale.setScalar(1);
}

function solveAlign(a, b) {
	const A = order[0], B = order[1];
	const yaw = ang(b.clone().sub(a)) - ang(B.clone().sub(A));
	const RA = rotY(A, yaw);
	Object.assign(al, { x: a.x - RA.x, y: -floorY, z: a.z - RA.z, yaw });
	applyAlign();
	const real = a.distanceTo(b), cad = Math.hypot(B.x - A.x, B.z - A.z);
	if (mini) { scene.remove(mini); mini = null; }
	world.visible = true;
	state = 'xray';
	const [p] = eyePose();
	drawPanel('ALIGNED', 'X-ray on. Aim and pull the trigger.',
		[`Wall: CAD ${cad.toFixed(2)} m · your points ${real.toFixed(2)} m`,
		 'Left stick: move · Right stick: rotate / height', 'A/X: align again · B/Y: layers · Grip: hide'], '#40e6ff');
	placePanel(p.clone().add(new THREE.Vector3(0, -0.1, 0)).addScaledVector(eyePose()[1], 1.0), p, 1);
	panel.scale.setScalar(1);
}

function trigger(c) {
	audio();
	const [o, d] = ctrlRay(c);
	const src = c.userData.src;
	if (state === 'align1' || state === 'align2') {
		const h = floorHit(o, d);
		if (!h || !mini) return;
		src?.gamepad?.hapticActuators?.[0]?.pulse?.(0.4, 30);
		pew();
		const m = new THREE.Mesh(new THREE.RingGeometry(0.04, 0.06, 24),
			new THREE.MeshBasicMaterial({ color: clicks.length ? 0xff3344 : 0x33ff66, side: THREE.DoubleSide, depthTest: false }));
		m.rotation.x = -Math.PI / 2;
		m.position.copy(h).setY(0.002);
		m.renderOrder = 12;
		scene.add(m);
		marks.push(m);
		clicks.push(h);
		if (clicks.length === 1) { state = 'align2'; alignText(); }
		else solveAlign(clicks[0], clicks[1]);
	} else if (state === 'xray') {
		shoot(o, d, eyePose()[0], src);
	}
}

function xrUpdate(dt) {
	if (needMini) { needMini = false; showMini(); }
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
			at = floorHit(o, d);
			if (at) len = o.distanceTo(at);
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
		if (btn(4)) startAlign();
		if (btn(5) && state === 'xray') {
			layer = (layer + 1) % 3;
			applyLayer();
			drawPanel('LAYER', LAYERS[layer], [['Everything', 'Walls, openings, furniture', 'Pipes, wiring, outlets, studs'][layer]]);
			placePanel(eye.clone().addScaledVector(f, 1.0).add(new THREE.Vector3(0, -0.15, 0)), eye, 1);
			panel.scale.setScalar(1);
		}
		c.userData.prev = gp.buttons.map(b => b.pressed);
		if (state !== 'xray') continue;
		const ax = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0] || 0;
		const ay = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1] || 0;
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
renderer.setAnimationLoop(t => {
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
		const s = await navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['local-floor'] });
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
