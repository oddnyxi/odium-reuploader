'use strict';
const fs = require('fs');
const { parseBundle } = require('./bundle');
const { decodeTexture, isCrunched, isSupported } = require('./texture');

const FMT_SIZE = [4, 2, 1, 1, 2, 2, 1, 1, 2, 2, 4, 4];

class Reader {
  constructor(buf, le = true) { this.b = buf; this.p = 0; this.le = le; }
  u8() { return this.b[this.p++]; }
  i8() { return this.b.readInt8(this.p++); }
  u16() { const v = this.le ? this.b.readUInt16LE(this.p) : this.b.readUInt16BE(this.p); this.p += 2; return v; }
  i16() { const v = this.le ? this.b.readInt16LE(this.p) : this.b.readInt16BE(this.p); this.p += 2; return v; }
  u32() { const v = this.le ? this.b.readUInt32LE(this.p) : this.b.readUInt32BE(this.p); this.p += 4; return v; }
  i32() { const v = this.le ? this.b.readInt32LE(this.p) : this.b.readInt32BE(this.p); this.p += 4; return v; }
  i64() { const v = this.le ? this.b.readBigInt64LE(this.p) : this.b.readBigInt64BE(this.p); this.p += 8; return (v >= -9007199254740991n && v <= 9007199254740991n) ? Number(v) : v; }
  f32() { const v = this.le ? this.b.readFloatLE(this.p) : this.b.readFloatBE(this.p); this.p += 4; return v; }
  f64() { const v = this.le ? this.b.readDoubleLE(this.p) : this.b.readDoubleBE(this.p); this.p += 8; return v; }
  cstr() { const e = this.b.indexOf(0, this.p); const s = this.b.toString('utf8', this.p, e); this.p = e + 1; return s; }
  align(n = 4) { this.p = (this.p + n - 1) & ~(n - 1); }
}

function readTypeTree(r, version) {
  const count = r.u32(), strLen = r.u32();
  const nodes = [];
  const nodeSize = version >= 19 ? 32 : 24;
  const start = r.p;
  r.p += count * nodeSize;
  const strBuf = r.b.subarray(r.p, r.p + strLen);
  r.p += strLen;
  const COMMON = {"0":"AABB","5":"AnimationClip","19":"AnimationCurve","34":"AnimationState","49":"Array","55":"Base","60":"BitField","69":"bitset","76":"bool","81":"char","86":"ColorRGBA","96":"Component","106":"data","111":"deque","117":"double","124":"dynamic_array","138":"FastPropertyName","155":"first","161":"float","167":"Font","172":"GameObject","183":"Generic Mono","196":"GradientNEW","208":"GUID","213":"GUIStyle","222":"int","226":"list","231":"long long","241":"map","245":"Matrix4x4f","256":"MdFour","263":"MonoBehaviour","277":"MonoScript","288":"m_ByteSize","299":"m_Curve","307":"m_EditorClassIdentifier","331":"m_EditorHideFlags","349":"m_Enabled","359":"m_ExtensionPtr","374":"m_GameObject","387":"m_Index","395":"m_IsArray","405":"m_IsStatic","416":"m_MetaFlag","427":"m_Name","434":"m_ObjectHideFlags","452":"m_PrefabInternal","469":"m_PrefabParentObject","490":"m_Script","499":"m_StaticEditorFlags","519":"m_Type","526":"m_Version","536":"Object","543":"pair","548":"PPtr<Component>","564":"PPtr<GameObject>","581":"PPtr<Material>","596":"PPtr<MonoBehaviour>","616":"PPtr<MonoScript>","633":"PPtr<Object>","646":"PPtr<Prefab>","659":"PPtr<Sprite>","672":"PPtr<TextAsset>","688":"PPtr<Texture>","702":"PPtr<Texture2D>","718":"PPtr<Transform>","734":"Prefab","741":"Quaternionf","753":"Rectf","759":"RectInt","767":"RectOffset","778":"second","785":"set","789":"short","795":"size","800":"SInt16","807":"SInt32","814":"SInt64","821":"SInt8","827":"staticvector","840":"string","847":"TextAsset","857":"TextMesh","866":"Texture","874":"Texture2D","884":"Transform","894":"TypelessData","907":"UInt16","914":"UInt32","921":"UInt64","928":"UInt8","934":"unsigned int","947":"unsigned long long","966":"unsigned short","981":"vector","988":"Vector2f","997":"Vector3f","1006":"Vector4f","1015":"m_ScriptingClassIdentifier","1042":"Gradient","1051":"Type*","1057":"int2_storage","1070":"int3_storage","1083":"BoundsInt","1093":"m_CorrespondingSourceObject","1121":"m_PrefabInstance","1138":"m_PrefabAsset","1152":"FileSize","1161":"Hash128","1169":"RenderingLayerMask","1188":"fixed_array","1200":"EntityId","1209":"LoadableObjectId","1226":"LoadableSceneId"};
  const str = (off) => {
    if (off & 0x80000000) return COMMON[off & 0x7fffffff] || '?';
    const e = strBuf.indexOf(0, off); return strBuf.toString('utf8', off, e);
  };
  const t = new Reader(r.b, r.le); t.p = start;
  for (let i = 0; i < count; i++) {
    const n = { version: t.u16(), level: t.u8(), array: t.u8(), typeOff: t.u32(), nameOff: t.u32(), size: t.i32(), index: t.u32(), flags: t.u32() };
    if (version >= 19) t.p += 8;
    n.type = str(n.typeOff); n.name = str(n.nameOff);
    nodes.push(n);
  }
  return nodes;
}

function readValue(r, nodes, i) {
  const n = nodes[i];
  let end = i + 1;
  while (end < nodes.length && nodes[end].level > n.level) end++;
  const children = [];
  for (let j = i + 1; j < end; j++) { children.push(j); let k = j + 1; while (k < end && nodes[k].level > nodes[j].level) k++; j = k - 1; }
  const aligned = (n.flags & 0x4000) !== 0;
  let v;
  switch (n.type) {
    case 'SInt8': v = r.i8(); break;
    case 'UInt8': case 'char': v = r.u8(); break;
    case 'bool': v = r.u8() !== 0; break;
    case 'SInt16': case 'short': v = r.i16(); break;
    case 'UInt16': case 'unsigned short': v = r.u16(); break;
    case 'SInt32': case 'int': v = r.i32(); break;
    case 'UInt32': case 'unsigned int': v = r.u32(); break;
    case 'SInt64': case 'long long': case 'UInt64': case 'unsigned long long': v = r.i64(); break;
    case 'float': v = r.f32(); break;
    case 'double': v = r.f64(); break;
    case 'string': {
      const len = r.i32(); v = r.b.toString('utf8', r.p, r.p + len); r.p += len; r.align(4); return v;
    }
    case 'TypelessData': {
      const size = r.i32(); v = r.b.subarray(r.p, r.p + size); r.p += size;
      if (aligned) r.align(4);
      return v;
    }
    default: {
      if (n.array && children.length >= 2 && nodes[children[0]].name === 'size') {
        const size = r.i32();
        const el = children[1];
        const et = nodes[el];
        if (et.type === 'UInt8' || et.type === 'SInt8' || et.type === 'char') {
          v = r.b.subarray(r.p, r.p + size); r.p += size;
        } else {
          v = new Array(size);
          for (let k = 0; k < size; k++) v[k] = readValue(r, nodes, el);
        }
        if (aligned) r.align(4);
        return v;
      }
      v = {};
      for (const c of children) v[nodes[c].name] = readValue(r, nodes, c);
      if (children.length === 1 && nodes[children[0]].array && 'Array' in v) v = v.Array;
    }
  }
  if (aligned) r.align(4);
  return v;
}

function parseSerialized(buf) {
  const h = new Reader(buf, false);
  h.u32(); h.u32();
  const version = h.u32();
  let dataOffset = h.u32();
  let le = true;
  if (version >= 9) { le = h.u8() === 0; h.p += 3; }
  if (version >= 22) { h.p = 0x14; h.u32(); h.i64(); dataOffset = Number(h.i64()); h.i64(); }
  const r = new Reader(buf, le);
  if (version >= 22) r.p = 0x30;
  r.cstr();
  r.u32();
  const hasTypeTree = r.u8() !== 0;
  const typeCount = r.u32();
  const types = [];
  for (let i = 0; i < typeCount; i++) {
    const classId = r.i32();
    r.u8();
    r.i16();
    if (classId === 114) r.p += 16;
    r.p += 16;
    let nodes = null;
    if (hasTypeTree) nodes = readTypeTree(r, version);
    if (version >= 21) { const dep = r.u32(); r.p += dep * 4; }
    types.push({ classId, nodes });
  }
  const objCount = r.u32();
  const objects = [];
  for (let i = 0; i < objCount; i++) {
    if (version >= 14) r.align(4);
    const pathId = String(r.i64());
    const off = version >= 22 ? Number(r.i64()) : r.u32();
    const size = r.u32();
    const typeIndex = r.u32();
    objects.push({ pathId, offset: dataOffset + off, size, type: types[typeIndex] });
  }
  return { version, le, objects };
}

function decodeVertexChannel(vd, ch, ci, stride, streamOff, count) {
  const dim = ch.dimension & 0x0f;
  const out = new Float32Array(count * dim);
  const fs_ = FMT_SIZE[ch.format];
  const d = vd.m_DataSize;
  for (let v = 0; v < count; v++) {
    let p = streamOff + v * stride + ch.offset;
    for (let k = 0; k < dim; k++, p += fs_) {
      let x;
      switch (ch.format) {
        case 0: x = d.readFloatLE(p); break;
        case 1: { const hv = d.readUInt16LE(p); const s = (hv >> 15) ? -1 : 1, e = (hv >> 10) & 31, m = hv & 1023; x = e === 0 ? s * 5.960464477539063e-8 * m : e === 31 ? (m ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + m / 1024); break; }
        case 2: x = d[p] / 255; break;
        case 3: x = Math.max(d.readInt8(p) / 127, -1); break;
        case 4: x = d.readUInt16LE(p) / 65535; break;
        case 5: x = Math.max(d.readInt16LE(p) / 32767, -1); break;
        case 6: x = d[p]; break;
        case 7: x = d.readInt8(p); break;
        case 8: x = d.readUInt16LE(p); break;
        case 9: x = d.readInt16LE(p); break;
        case 10: x = d.readUInt32LE(p); break;
        default: x = d.readInt32LE(p);
      }
      out[v * dim + k] = x;
    }
  }
  return { out, dim };
}

function extractMesh(obj, buf, le) {
  const nodes = obj.type.nodes;
  if (!nodes) return null;
  const r = new Reader(buf, le);
  r.p = obj.offset;
  const m = readValue(r, nodes, 0);
  const vd = m.m_VertexData;
  if (!vd || !vd.m_VertexCount || !m.m_IndexBuffer || !m.m_IndexBuffer.length) return null;
  const count = vd.m_VertexCount;
  const chans = vd.m_Channels.filter((c) => (c.dimension & 0x0f) > 0);
  const streams = {};
  vd.m_Channels.forEach((c, i) => {
    const dim = c.dimension & 0x0f;
    if (!dim) return;
    (streams[c.stream] = streams[c.stream] || { ch: [], stride: 0 });
    streams[c.stream].ch.push(i);
    streams[c.stream].stride += dim * FMT_SIZE[c.format];
  });
  const offs = {};
  let o = 0;
  for (const s of Object.keys(streams).map(Number).sort((a, b) => a - b)) {
    offs[s] = o; o += streams[s].stride * count; o = (o + 15) & ~15;
  }
  const pc = vd.m_Channels[0];
  if (!pc || !(pc.dimension & 0x0f)) return null;
  const pos = decodeVertexChannel(vd, pc, 0, streams[pc.stream].stride, offs[pc.stream], count);
  let nrm = null;
  const nc = vd.m_Channels[1];
  if (nc && (nc.dimension & 0x0f) >= 3) nrm = decodeVertexChannel(vd, nc, 1, streams[nc.stream].stride, offs[nc.stream], count);
  let uv = null;
  const uc = vd.m_Channels[4];
  if (uc && (uc.dimension & 0x0f) >= 2 && streams[uc.stream]) {
    const d = decodeVertexChannel(vd, uc, 4, streams[uc.stream].stride, offs[uc.stream], count);
    if (d.dim === 2) uv = d.out;
    else { uv = new Float32Array(count * 2); for (let i = 0; i < count; i++) { uv[i * 2] = d.out[i * d.dim]; uv[i * 2 + 1] = d.out[i * d.dim + 1]; } }
  }
  let skin = null;
  const wc = vd.m_Channels[12], ic = vd.m_Channels[13];
  if (wc && ic && (wc.dimension & 0x0f) > 0 && (ic.dimension & 0x0f) > 0 && streams[wc.stream] && streams[ic.stream]) {
    const w = decodeVertexChannel(vd, wc, 12, streams[wc.stream].stride, offs[wc.stream], count);
    const ix = decodeVertexChannel(vd, ic, 13, streams[ic.stream].stride, offs[ic.stream], count);
    skin = { w: w.out, wdim: w.dim, ix: ix.out, idim: ix.dim };
  }
  const bind = (m.m_BindPose || []).map((b) => [
    b.e00, b.e01, b.e02, b.e03, b.e10, b.e11, b.e12, b.e13, b.e20, b.e21, b.e22, b.e23, b.e30, b.e31, b.e32, b.e33,
  ]);
  const ib = m.m_IndexBuffer;
  const u32 = m.m_IndexFormat === 1;
  const total = ib.length / (u32 ? 4 : 2);
  const idx = new Uint32Array(total);
  for (let i = 0; i < total; i++) idx[i] = u32 ? ib.readUInt32LE(i * 4) : ib.readUInt16LE(i * 2);
  const tris = [];
  const subs = [];
  for (const sm of m.m_SubMeshes || []) {
    const first = sm.firstByte / (u32 ? 4 : 2);
    const n = sm.indexCount;
    const subStart = tris.length;
    if (sm.topology === 0) { for (let i = 0; i + 2 < n; i += 3) tris.push(idx[first + i], idx[first + i + 1], idx[first + i + 2]); }
    else if (sm.topology === 1) { for (let i = 0; i + 2 < n; i++) { const a = idx[first + i], b = idx[first + i + 1], c = idx[first + i + 2]; if (a === b || b === c || a === c) continue; if (i & 1) tris.push(a, c, b); else tris.push(a, b, c); } }
    subs.push({ start: subStart, count: tris.length - subStart });
  }
  if (!tris.length) return null;
  return { name: m.m_Name || 'mesh', positions: pos.out, posDim: pos.dim, normals: nrm ? nrm.out : null, uv, indices: Uint32Array.from(tris), subs, skin, bind };
}


const mm = (a, b) => {
  const o = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
  }
  return o;
};
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function trs(t) {
  const { x, y, z, w } = t.rot, p = t.pos, s = t.scl;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * s.x, 2 * (xy - wz) * s.y, 2 * (xz + wy) * s.z, p.x,
    2 * (xy + wz) * s.x, (1 - 2 * (xx + zz)) * s.y, 2 * (yz - wx) * s.z, p.y,
    2 * (xz - wy) * s.x, 2 * (yz + wx) * s.y, (1 - 2 * (xx + yy)) * s.z, p.z,
    0, 0, 0, 1,
  ];
}
const pid = (pp) => (pp && (pp.m_FileID === 0 || pp.m_FileID === undefined) && pp.m_PathID !== 0 && pp.m_PathID !== 0n ? String(pp.m_PathID) : null);

function buildScene(sf, slice, maxTris, getRes, shared) {
  const byId = new Map();
  for (const o of sf.objects) byId.set(o.pathId, o);
  const rd = (o) => { const r = new Reader(slice, sf.le); r.p = o.offset; return readValue(r, o.type.nodes, 0); };
  const gos = new Map(), tfs = new Map(), goToT = new Map(), rends = [], filters = new Map();
  for (const o of sf.objects) {
    const c = o.type.classId;
    if (!o.type.nodes) continue;
    try {
      if (c === 1) { const g = rd(o); gos.set(o.pathId, { name: g.m_Name, active: g.m_IsActive !== false && g.m_IsActive !== 0 }); }
      else if (c === 4 || c === 224) {
        const t = rd(o);
        tfs.set(o.pathId, { go: pid(t.m_GameObject), father: pid(t.m_Father), rot: t.m_LocalRotation, pos: t.m_LocalPosition, scl: t.m_LocalScale });
        goToT.set(pid(t.m_GameObject), o.pathId);
      } else if (c === 137) {
        const r = rd(o);
        rends.push({ skinned: true, go: pid(r.m_GameObject), enabled: r.m_Enabled !== false && r.m_Enabled !== 0, mesh: pid(r.m_Mesh), bones: (r.m_Bones || []).map(pid), mats: (r.m_Materials || []).map(pid) });
      } else if (c === 23) {
        const r = rd(o);
        rends.push({ skinned: false, go: pid(r.m_GameObject), enabled: r.m_Enabled !== false && r.m_Enabled !== 0, mesh: null, bones: [], mats: (r.m_Materials || []).map(pid) });
      } else if (c === 33) {
        const f = rd(o); filters.set(pid(f.m_GameObject), pid(f.m_Mesh));
      }
    } catch { /* skip unreadable component */ }
  }
  for (const r of rends) if (!r.skinned) r.mesh = filters.get(r.go) || null;

  const wm = new Map(), act = new Map();
  const world = (id, d = 0) => {
    if (wm.has(id)) return wm.get(id);
    const t = tfs.get(id);
    if (!t || d > 256) return IDENT;
    const l = trs(t);
    const w = t.father && tfs.has(t.father) ? mm(world(t.father, d + 1), l) : l;
    wm.set(id, w); return w;
  };
  const active = (id, d = 0) => {
    if (act.has(id)) return act.get(id);
    const t = tfs.get(id);
    if (!t || d > 256) return true;
    const g = gos.get(t.go);
    const a = (!g || g.active) && (t.father && tfs.has(t.father) ? active(t.father, d + 1) : true);
    act.set(id, a); return a;
  };


  const propName = (e) => (e && e.first && typeof e.first === 'object' ? e.first.name : e && e.first);
  const MAIN_TEX = ['_MainTex', '_BaseMap', '_BaseColorMap', '_Albedo', '_BaseTex', '_Diffuse'];
  const MAIN_COL = ['_Color', '_BaseColor', '_TintColor'];
  const texCache = shared.texCache, matCache = shared.matCache;
  const getTexture = (id) => {
    if (id === null) return -1;
    const key = sf.id + ':' + id;
    if (texCache.has(key)) return texCache.get(key);
    let idx = -1;
    const o = byId.get(id);
    if (o && o.type.classId === 28 && o.type.nodes) {
      try {
        const t = rd(o);
        if (isSupported(t.m_TextureFormat)) {
          const sd = t.m_StreamData;
          const stream = sd && sd.size ? getRes(sd.path, sd.offset, sd.size) : null;
          let dec = null;
          try { dec = decodeTexture(t, stream, 1024); } catch (e) {
            if (!isCrunched(t.m_TextureFormat)) throw e;
            shared.crunched.add(`${t.m_Name} (${e.message})`);
          }
          if (dec) { idx = shared.textures.length; shared.textures.push({ name: t.m_Name, w: dec.w, h: dec.h, data: dec.data }); }
        } else shared.unsupported.add(`${t.m_Name} (format ${t.m_TextureFormat})`);
      } catch { /* leave untextured */ }
    }
    texCache.set(key, idx);
    return idx;
  };
  const getMaterial = (id) => {
    if (id === null) return -1;
    const key = sf.id + ':' + id;
    if (matCache.has(key)) return matCache.get(key);
    let idx = -1;
    const o = byId.get(id);
    if (o && o.type.classId === 21 && o.type.nodes) {
      try {
        const m = rd(o), sp = m.m_SavedProperties || {};
        const envs = sp.m_TexEnvs || [], cols = sp.m_Colors || [], fl = sp.m_Floats || [];
        let tex = -1, st = [1, 1, 0, 0], tname = null;
        for (const nm of MAIN_TEX) {
          const e = envs.find((x) => propName(x) === nm);
          const tid = e ? pid(e.second.m_Texture) : null;
          if (tid) {
            tex = getTexture(tid); tname = nm;
            const sc = e.second.m_Scale || { x: 1, y: 1 }, of = e.second.m_Offset || { x: 0, y: 0 };
            st = [sc.x, sc.y, of.x, of.y];
            break;
          }
        }
        let color = [1, 1, 1, 1];
        for (const nm of MAIN_COL) {
          const c = cols.find((x) => propName(x) === nm);
          if (c) { color = [c.second.r, c.second.g, c.second.b, c.second.a]; break; }
        }
        const num = (nm) => { const f = fl.find((x) => propName(x) === nm); return f ? f.second : undefined; };
        const mode = num('_Mode');
        const cutoff = num('_Cutoff') ?? 0.5;
        idx = shared.materials.length;
        shared.materials.push({ name: m.m_Name, tex, st, color, cutout: mode === 1, cutoff, textured: tex >= 0 });
      } catch { /* leave default */ }
    }
    matCache.set(key, idx);
    return idx;
  };

  const meshCache = new Map();
  const out = [];
  let tris = 0;
  for (const r of rends) {
    if (!r.enabled || !r.mesh) continue;
    const tid = goToT.get(r.go);
    if (!tid || !active(tid)) continue;
    const mo = byId.get(r.mesh);
    if (!mo || mo.type.classId !== 43) continue;
    let m = meshCache.get(r.mesh);
    if (m === undefined) { try { m = extractMesh(mo, slice, sf.le); } catch { m = null; } meshCache.set(r.mesh, m); }
    if (!m) continue;
    const nt = m.indices.length / 3;
    if (tris + nt > maxTris) continue;
    const cnt = m.positions.length / m.posDim, pd = m.posDim;
    const P = new Float32Array(cnt * 3), N = new Float32Array(cnt * 3);
    const nd = m.normals ? m.normals.length / cnt : 0;
    const useSkin = r.skinned && m.skin && r.bones.length && m.bind.length === r.bones.length;
    if (useSkin) {
      const B = r.bones.map((b, i) => (b && tfs.has(b) ? mm(world(b), m.bind[i]) : null));
      const { w, wdim, ix, idim } = m.skin;
      for (let v = 0; v < cnt; v++) {
        const x = m.positions[v * pd], y = m.positions[v * pd + 1], z = m.positions[v * pd + 2];
        const nx = nd ? m.normals[v * nd] : 0, ny = nd ? m.normals[v * nd + 1] : 0, nz = nd ? m.normals[v * nd + 2] : 0;
        let sum = 0;
        for (let k = 0; k < Math.min(4, wdim, idim); k++) sum += B[ix[v * idim + k]] ? w[v * wdim + k] : 0;
        let px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0;
        for (let k = 0; k < Math.min(4, wdim, idim); k++) {
          const M = B[ix[v * idim + k]];
          if (!M) continue;
          const wt = sum > 0 ? w[v * wdim + k] / sum : 0;
          if (!wt) continue;
          px += wt * (M[0] * x + M[1] * y + M[2] * z + M[3]);
          py += wt * (M[4] * x + M[5] * y + M[6] * z + M[7]);
          pz += wt * (M[8] * x + M[9] * y + M[10] * z + M[11]);
          qx += wt * (M[0] * nx + M[1] * ny + M[2] * nz);
          qy += wt * (M[4] * nx + M[5] * ny + M[6] * nz);
          qz += wt * (M[8] * nx + M[9] * ny + M[10] * nz);
        }
        P[v * 3] = px; P[v * 3 + 1] = py; P[v * 3 + 2] = pz;
        N[v * 3] = qx; N[v * 3 + 1] = qy; N[v * 3 + 2] = qz;
      }
    } else {
      const M = world(tid);
      for (let v = 0; v < cnt; v++) {
        const x = m.positions[v * pd], y = m.positions[v * pd + 1], z = m.positions[v * pd + 2];
        P[v * 3] = M[0] * x + M[1] * y + M[2] * z + M[3];
        P[v * 3 + 1] = M[4] * x + M[5] * y + M[6] * z + M[7];
        P[v * 3 + 2] = M[8] * x + M[9] * y + M[10] * z + M[11];
        if (nd) {
          const nx = m.normals[v * nd], ny = m.normals[v * nd + 1], nz = m.normals[v * nd + 2];
          N[v * 3] = M[0] * nx + M[1] * ny + M[2] * nz;
          N[v * 3 + 1] = M[4] * nx + M[5] * ny + M[6] * nz;
          N[v * 3 + 2] = M[8] * nx + M[9] * ny + M[10] * nz;
        }
      }
    }
    tris += nt;
    const groups = [];
    (m.subs || []).forEach((sb, i) => {
      if (!sb.count) return;
      const mid = r.mats.length ? getMaterial(r.mats[Math.min(i, r.mats.length - 1)]) : -1;
      groups.push({ start: sb.start, count: sb.count, mat: mid });
    });
    if (!groups.length) groups.push({ start: 0, count: m.indices.length, mat: -1 });
    out.push({ name: m.name, positions: P, posDim: 3, normals: nd ? N : null, uv: m.uv, indices: m.indices, groups, world: true });
  }
  return { meshes: out, triangles: tris };
}

function readMeshes(file, maxTris = 1500000) {
  const buf = fs.readFileSync(file);
  const bundle = parseBundle(buf);
  const data = Buffer.concat(bundle.blocks.map((b) => b.data));
  const getRes = (p, off, size) => {
    const base = String(p || '').split('/').pop();
    const node = bundle.nodes.find((n) => n.name === base || n.name.endsWith('/' + base));
    if (!node) return null;
    return data.subarray(node.offset + off, node.offset + off + size);
  };
  const shared = { texCache: new Map(), matCache: new Map(), textures: [], materials: [], crunched: new Set(), unsupported: new Set() };
  let scene = { meshes: [], triangles: 0 };
  for (const node of bundle.nodes) {
    if (/\.(resS|resource)$/i.test(node.name)) continue;
    const slice = data.subarray(node.offset, node.offset + node.size);
    let sf;
    try { sf = parseSerialized(slice); sf.id = node.name; } catch { continue; }
    try {
      const r = buildScene(sf, slice, maxTris, getRes, shared);
      scene.meshes.push(...r.meshes); scene.triangles += r.triangles;
    } catch { /* fall through to raw listing */ }
  }
  if (scene.meshes.length) {
    // only ship textures that a drawn material actually uses
    const used = new Set();
    for (const m of scene.meshes) for (const g of m.groups) if (g.mat >= 0 && shared.materials[g.mat].tex >= 0) used.add(shared.materials[g.mat].tex);
    const remap = new Map(); const textures = [];
    [...used].sort((a, b) => a - b).forEach((i) => { remap.set(i, textures.length); textures.push(shared.textures[i]); });
    const materials = shared.materials.map((m) => ({ ...m, tex: m.tex >= 0 && remap.has(m.tex) ? remap.get(m.tex) : -1 }));
    const notes = [];
    if (shared.crunched.size) notes.push(`${shared.crunched.size} Crunch-compressed texture(s) could not be decoded (shown untextured): ${[...shared.crunched].slice(0, 6).join(', ')}${shared.crunched.size > 6 ? '…' : ''}`);
    if (shared.unsupported.size) notes.push(`Unsupported texture format: ${[...shared.unsupported].slice(0, 4).join(', ')}`);
    return { ...scene, materials, textures, notes };
  }
  // fallback: no usable hierarchy, list raw meshes
  const meshes = []; let tris = 0;
  for (const node of bundle.nodes) {
    if (/\.(resS|resource)$/i.test(node.name)) continue;
    const slice = data.subarray(node.offset, node.offset + node.size);
    let sf; try { sf = parseSerialized(slice); } catch { continue; }
    for (const obj of sf.objects) {
      if (obj.type.classId !== 43) continue;
      let m; try { m = extractMesh(obj, slice, sf.le); } catch { continue; }
      if (!m) continue;
      const t = m.indices.length / 3;
      if (tris + t > maxTris) continue;
      tris += t; meshes.push(m);
    }
  }
  return { meshes, triangles: tris, materials: [], textures: [], notes: [] };
}

module.exports = { readMeshes, parseSerialized, readValue, Reader };
