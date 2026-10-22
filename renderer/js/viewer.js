(() => {
  const VS = 'attribute vec3 p;attribute vec3 n;attribute vec2 u;uniform mat4 m;varying vec3 vn;varying vec2 vu;void main(){vn=n;vu=u;gl_Position=m*vec4(p,1.);}';
  const FS = 'precision mediump float;varying vec3 vn;varying vec2 vu;uniform mat3 r;uniform sampler2D t;uniform float ht;uniform vec4 st;uniform vec4 tint;uniform float co;' +
    'void main(){vec4 a=vec4(.93,.92,.97,1.);if(ht>.5)a=texture2D(t,vu*st.xy+st.zw);if(co>0.&&a.a<co)discard;' +
    'vec3 N=normalize(r*vn);float d=max(dot(N,normalize(vec3(.4,.8,.6))),0.);float f=max(dot(N,normalize(vec3(-.6,.2,-.5))),0.)*.3;' +
    'vec3 c=a.rgb*tint.rgb*(.28+d*.75+f);gl_FragColor=vec4(c,1.);}';

  function mul(a, b) {
    const o = new Float32Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s; }
    return o;
  }
  const rotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); };
  const rotX = (a) => { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]); };

  function create(canvas) {
    const gl = canvas.getContext('webgl', { antialias: true, alpha: true });
    if (!gl) return null;
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(pr); gl.useProgram(pr);
    const loc = { p: gl.getAttribLocation(pr, 'p'), n: gl.getAttribLocation(pr, 'n'), u: gl.getAttribLocation(pr, 'u'), m: gl.getUniformLocation(pr, 'm'), r: gl.getUniformLocation(pr, 'r'),
      t: gl.getUniformLocation(pr, 't'), ht: gl.getUniformLocation(pr, 'ht'), st: gl.getUniformLocation(pr, 'st'), tint: gl.getUniformLocation(pr, 'tint'), co: gl.getUniformLocation(pr, 'co') };
    gl.uniform1i(loc.t, 0);
    gl.getExtension('OES_element_index_uint');
    gl.enable(gl.DEPTH_TEST);

    let draws = [], texs = [], mats = [], radius = 1, center = [0, 0, 0];
    let yaw = 0.6, pitch = 0.12, zoom = 1, spin = true, raf = 0, dragging = false, lx = 0, ly = 0;

    function load(meshes, materials, textures) {
      for (const d of draws) { gl.deleteBuffer(d.vb); gl.deleteBuffer(d.nb); gl.deleteBuffer(d.ub); gl.deleteBuffer(d.ib); }
      for (const t of texs) gl.deleteTexture(t);
      draws = []; texs = []; mats = materials || [];
      for (const t of textures || []) {
        const tx = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tx);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // Unity rows are already bottom-up
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, t.w, t.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, t.data instanceof Uint8Array ? t.data : new Uint8Array(t.data));
        const pot = (v) => (v & (v - 1)) === 0;
        if (pot(t.w) && pot(t.h)) {
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        } else {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        texs.push(tx);
      }
      const info = meshes.map((m) => {
        const dim = m.posDim, cnt = m.positions.length / dim;
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < cnt; i++) for (let k = 0; k < 3; k++) {
          const v = m.positions[i * dim + k];
          if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v;
        }
        const e = mx.map((v, k) => v - mn[k]), c = mx.map((v, k) => (v + mn[k]) / 2);
        let zUp;
        if (m.world) zUp = false;
        else if (Math.abs(c[2]) > Math.abs(c[1]) * 1.5 + 0.05) zUp = true;
        else if (Math.abs(c[1]) > Math.abs(c[2]) * 1.5 + 0.05) zUp = false;
        else zUp = e[2] > e[1] * 1.15;
        return { cnt, dim, diag: Math.hypot(e[0], e[1], e[2]), zUp, tris: m.indices.length / 3 };
      });
      const ref = info.reduce((a, b) => (b.tris > a.tris ? b : a), info[0] || { diag: 1, tris: 0 });
      let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      meshes.forEach((m, mi) => {
        const { cnt, dim, zUp, diag } = info[mi];
        if (!meshes[mi].world && diag > ref.diag * 2.5) return;
        const cv = (x, y, z) => (zUp ? [-x, z, -y] : [-x, y, z]);
        const pos = new Float32Array(cnt * 3);
        for (let i = 0; i < cnt; i++) {
          const c = cv(m.positions[i * dim], m.positions[i * dim + 1], m.positions[i * dim + 2]);
          pos[i * 3] = c[0]; pos[i * 3 + 1] = c[1]; pos[i * 3 + 2] = c[2];
          for (let k = 0; k < 3; k++) { if (c[k] < mn[k]) mn[k] = c[k]; if (c[k] > mx[k]) mx[k] = c[k]; }
        }
        let nrm;
        if (m.normals) {
          const nd = m.normals.length / cnt; nrm = new Float32Array(cnt * 3);
          for (let i = 0; i < cnt; i++) {
            const c = cv(m.normals[i * nd], m.normals[i * nd + 1], m.normals[i * nd + 2]);
            nrm[i * 3] = c[0]; nrm[i * 3 + 1] = c[1]; nrm[i * 3 + 2] = c[2];
          }
        } else {
          nrm = new Float32Array(cnt * 3);
          const ix = m.indices;
          for (let t = 0; t < ix.length; t += 3) {
            const a = ix[t] * 3, b = ix[t + 2] * 3, c = ix[t + 1] * 3;
            const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
            const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            for (const q of [a, b, c]) { nrm[q] += nx; nrm[q + 1] += ny; nrm[q + 2] += nz; }
          }
        }
        const mk = (type, data) => { const b = gl.createBuffer(); gl.bindBuffer(type, b); gl.bufferData(type, data, gl.STATIC_DRAW); return b; };
        const big = cnt > 65535;
        const uvd = m.uv && m.uv.length === cnt * 2 ? Float32Array.from(m.uv) : new Float32Array(cnt * 2);
        draws.push({ vb: mk(gl.ARRAY_BUFFER, pos), nb: mk(gl.ARRAY_BUFFER, nrm), ub: mk(gl.ARRAY_BUFFER, uvd), ib: mk(gl.ELEMENT_ARRAY_BUFFER, big ? m.indices : Uint16Array.from(m.indices)), n: m.indices.length, big,
          groups: m.groups && m.groups.length ? m.groups : [{ start: 0, count: m.indices.length, mat: -1 }] });
      });
      if (!draws.length) return;
      center = mn.map((v, k) => (v + mx[k]) / 2);
      radius = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2 || 1;
      reset();
    }

    function frame() {
      raf = requestAnimationFrame(frame);
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (spin && !dragging) yaw += 0.006;
      const s = 1 / (radius * 1.15) * zoom, a = h / w;
      const t = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -center[0], -center[1], -center[2], 1]);
      const rot = mul(rotX(pitch), rotY(yaw));
      const sc = new Float32Array([s * a, 0, 0, 0, 0, s, 0, 0, 0, 0, -s * 0.5, 0, 0, -0.05, 0, 1]);
      const mat = mul(sc, mul(rot, t));
      gl.uniformMatrix4fv(loc.m, false, mat);
      gl.uniformMatrix3fv(loc.r, false, new Float32Array([rot[0], rot[1], rot[2], rot[4], rot[5], rot[6], rot[8], rot[9], rot[10]]));
      gl.activeTexture(gl.TEXTURE0);
      for (const d of draws) {
        gl.bindBuffer(gl.ARRAY_BUFFER, d.vb); gl.enableVertexAttribArray(loc.p); gl.vertexAttribPointer(loc.p, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, d.nb); gl.enableVertexAttribArray(loc.n); gl.vertexAttribPointer(loc.n, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, d.ub); gl.enableVertexAttribArray(loc.u); gl.vertexAttribPointer(loc.u, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.ib);
        for (const g of d.groups) {
          const mt = g.mat >= 0 ? mats[g.mat] : null;
          const tx = mt && mt.tex >= 0 ? texs[mt.tex] : null;
          if (tx) gl.bindTexture(gl.TEXTURE_2D, tx);
          gl.uniform1f(loc.ht, tx ? 1 : 0);
          const st = mt ? mt.st : [1, 1, 0, 0], c = mt ? mt.color : [1, 1, 1, 1];
          gl.uniform4f(loc.st, st[0], st[1], st[2], st[3]);
          gl.uniform4f(loc.tint, c[0], c[1], c[2], 1);
          gl.uniform1f(loc.co, mt && mt.cutout && tx ? Math.max(mt.cutoff, 0.01) : -1);
          gl.drawElements(gl.TRIANGLES, g.count, d.big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, g.start * (d.big ? 4 : 2));
        }
      }
    }
    const reset = () => { yaw = 0.6; pitch = 0.12; zoom = 1; spin = true; };
    canvas.addEventListener('pointerdown', (e) => { dragging = true; spin = false; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => { if (!dragging) return; yaw += (e.clientX - lx) * 0.01; pitch = Math.max(-1.4, Math.min(1.4, pitch + (e.clientY - ly) * 0.01)); lx = e.clientX; ly = e.clientY; });
    canvas.addEventListener('pointerup', () => { dragging = false; });
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoom = Math.max(0.3, Math.min(6, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))); }, { passive: false });
    frame();
    return {
      load, reset,
      toggleSpin: () => { spin = !spin; return spin; },
      zoomBy: (f) => { zoom = Math.max(0.3, Math.min(6, zoom * f)); },
      clear: () => load([]),
      get spinning() { return spin; },
    };
  }
  window.OdiumViewer = { create };
})();
