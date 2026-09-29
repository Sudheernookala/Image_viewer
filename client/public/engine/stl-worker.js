/* Classic web worker: parses binary and ASCII STL off the main thread (dependency-free). */
onmessage = (ev) => {
  const { id, buffer } = ev.data;
  try {
    const dv = new DataView(buffer);
    let pos, nrm;
    const n = buffer.byteLength >= 84 ? dv.getUint32(80, true) : 0;
    if (buffer.byteLength === 84 + n * 50 && n > 0) {
      // binary STL: 50 bytes per triangle (normal, 3 vertices, attribute)
      pos = new Float32Array(n * 9);
      nrm = new Float32Array(n * 9);
      for (let i = 0, o = 84; i < n; i++, o += 50) {
        const nx = dv.getFloat32(o, true), ny = dv.getFloat32(o + 4, true), nz = dv.getFloat32(o + 8, true);
        for (let v = 0; v < 3; v++) {
          const k = i * 9 + v * 3, p = o + 12 + v * 12;
          pos[k] = dv.getFloat32(p, true);
          pos[k + 1] = dv.getFloat32(p + 4, true);
          pos[k + 2] = dv.getFloat32(p + 8, true);
          nrm[k] = nx; nrm[k + 1] = ny; nrm[k + 2] = nz;
        }
      }
    } else {
      const text = new TextDecoder().decode(buffer);
      const verts = [], norms = [];
      const re = /facet\s+normal\s+(\S+)\s+(\S+)\s+(\S+)|vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
      let m, cur = [0, 0, 0];
      while ((m = re.exec(text))) {
        if (m[1] !== undefined) cur = [+m[1], +m[2], +m[3]];
        else { verts.push(+m[4], +m[5], +m[6]); norms.push(cur[0], cur[1], cur[2]); }
      }
      if (!verts.length) throw new Error('Not a valid STL file');
      pos = new Float32Array(verts);
      nrm = new Float32Array(norms);
    }
    // Zero normals (common in exported STL) are recomputed per face.
    for (let i = 0; i < pos.length; i += 9) {
      if (nrm[i] || nrm[i + 1] || nrm[i + 2]) continue;
      const ax = pos[i + 3] - pos[i], ay = pos[i + 4] - pos[i + 1], az = pos[i + 5] - pos[i + 2];
      const bx = pos[i + 6] - pos[i], by = pos[i + 7] - pos[i + 1], bz = pos[i + 8] - pos[i + 2];
      let cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
      const l = Math.hypot(cx, cy, cz) || 1;
      cx /= l; cy /= l; cz /= l;
      for (let v = 0; v < 9; v += 3) { nrm[i + v] = cx; nrm[i + v + 1] = cy; nrm[i + v + 2] = cz; }
    }
    postMessage({ id, ok: true, position: pos, normal: nrm }, [pos.buffer, nrm.buffer]);
  } catch (e) {
    postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
};
