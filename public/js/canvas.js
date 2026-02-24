import { Palette, statusColor, hexToRGBA } from './palette.js';

const MIN_ZOOM = 0.08;
const MAX_ZOOM = 4.0;
const DEFAULT_ZOOM = 0.55;
const TAPER_STEPS = 30;

// Tapered width configs per connection thickness level
const TAPER = {
  3: { start: 24, end: 7 },   // hub → project
  2: { start: 14, end: 4 },   // project → branch
  1: { start: 7, end: 2 },    // branch → session
};

export class CanvasRenderer {
  constructor(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;

    this.zoomScale = DEFAULT_ZOOM;
    this.panOffset = { x: 0, y: 0 };
    this.positionOffsets = {};
    this.collapsedIDs = new Set();

    this.nodes = [];
    this.connections = [];
    this.nodeMap = {};
    this.childrenMap = {};
    this.cachedHiddenIDs = new Set();
    this.hiddenDirty = true;

    this.dirty = true;
    this.dragging = null;
    this.isPanning = false;
    this.onSessionClick = null;

    this._resize();
    this._bindEvents();
    this._loop();
  }

  setData(nodes, connections) {
    this.nodes = nodes;
    this.connections = connections;

    this.nodeMap = {};
    this.childrenMap = {};
    for (const n of nodes) {
      if (this.positionOffsets[n.id]) {
        n.x += this.positionOffsets[n.id].dx;
        n.y += this.positionOffsets[n.id].dy;
      }
      this.nodeMap[n.id] = n;
      if (!this.childrenMap[n.id]) this.childrenMap[n.id] = [];
      if (n.parentID) {
        if (!this.childrenMap[n.parentID]) this.childrenMap[n.parentID] = [];
        this.childrenMap[n.parentID].push(n.id);
      }
    }

    this.hiddenDirty = true;
    this.dirty = true;
  }

  // ── Resize & Events ──

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.dirty = true;
  }

  _bindEvents() {
    window.addEventListener('resize', () => this._resize());

    let mouseDownPos = null;
    let didDrag = false;

    this.canvas.addEventListener('mousedown', (e) => {
      const worldPos = this._screenToWorld(e.clientX, e.clientY);
      mouseDownPos = { x: e.clientX, y: e.clientY };
      didDrag = false;

      const badgeNode = this._hitTestBadge(worldPos.x, worldPos.y);
      if (badgeNode) {
        this._toggleCollapse(badgeNode.id);
        return;
      }

      const hitNode = this._hitTestNode(worldPos.x, worldPos.y);
      if (hitNode) {
        this.dragging = {
          nodeId: hitNode.id,
          startWorldX: worldPos.x,
          startWorldY: worldPos.y,
        };
      } else {
        this.isPanning = true;
        this.dragging = {
          nodeId: null,
          startScreenX: e.clientX,
          startScreenY: e.clientY,
          startPanX: this.panOffset.x,
          startPanY: this.panOffset.y,
        };
      }
    });

    this.canvas.addEventListener('mousemove', (e) => {
      if (!this.dragging && !this.isPanning) return;

      if (mouseDownPos) {
        const dx = e.clientX - mouseDownPos.x;
        const dy = e.clientY - mouseDownPos.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag = true;
      }

      if (this.isPanning && this.dragging) {
        this.panOffset.x = this.dragging.startPanX + (e.clientX - this.dragging.startScreenX);
        this.panOffset.y = this.dragging.startPanY + (e.clientY - this.dragging.startScreenY);
        this.dirty = true;
      } else if (this.dragging && this.dragging.nodeId) {
        const worldPos = this._screenToWorld(e.clientX, e.clientY);
        const dx = worldPos.x - this.dragging.startWorldX;
        const dy = worldPos.y - this.dragging.startWorldY;
        this.dragging.startWorldX = worldPos.x;
        this.dragging.startWorldY = worldPos.y;
        this._moveNodeSubtree(this.dragging.nodeId, dx, dy);
        this.dirty = true;
      }
    });

    const endDrag = () => {
      if (!didDrag && mouseDownPos && this.dragging && this.dragging.nodeId) {
        const node = this.nodeMap[this.dragging.nodeId];
        if (node && node.kind === 'session' && node.data && this.onSessionClick) {
          this.onSessionClick(node.data);
        }
      }
      this.dragging = null;
      this.isPanning = false;
      mouseDownPos = null;
    };

    this.canvas.addEventListener('mouseup', endDrag);
    this.canvas.addEventListener('mouseleave', endDrag);

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        this._zoomAt(e.clientX, e.clientY, 1 - e.deltaY * 0.01);
      } else {
        this.panOffset.x -= e.deltaX;
        this.panOffset.y -= e.deltaY;
        this.dirty = true;
      }
    }, { passive: false });
  }

  _zoomAt(screenX, screenY, factor) {
    const oldZoom = this.zoomScale;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldZoom * factor));
    const ratio = newZoom / oldZoom;
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    this.panOffset.x = screenX - ratio * (screenX - cx - this.panOffset.x) - cx;
    this.panOffset.y = screenY - ratio * (screenY - cy - this.panOffset.y) - cy;
    this.zoomScale = newZoom;
    this.dirty = true;
  }

  _screenToWorld(sx, sy) {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    return {
      x: (sx - cx - this.panOffset.x) / this.zoomScale,
      y: (sy - cy - this.panOffset.y) / this.zoomScale,
    };
  }

  // ── Hit Testing ──

  _nodeRect(node) {
    const label = node.label || '';
    switch (node.kind) {
      case 'hub':
        return { x: node.x - 110, y: node.y - 40, w: 220, h: 80, r: 40 };
      case 'project': {
        const w = Math.max(label.length * 10 + 50, 160);
        return { x: node.x - w / 2, y: node.y - 25, w, h: 50, r: 25 };
      }
      case 'branch': {
        const w = Math.max(label.length * 9 + 40, 100);
        return { x: node.x - w / 2, y: node.y - 18, w, h: 36, r: 18 };
      }
      case 'session': {
        const isArchived = node.data && node.data.status === 'archived';
        // archived: 2 lines of prompt. active: status + 3 prompt + 5 summary lines
        const h = isArchived ? 50 : 148;
        return { x: node.x - 130, y: node.y - h / 2, w: 260, h, r: 12 };
      }
      default:
        return { x: node.x - 50, y: node.y - 25, w: 100, h: 50, r: 12 };
    }
  }

  _hitTestNode(wx, wy) {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (this.cachedHiddenIDs.has(n.id)) continue;
      const r = this._nodeRect(n);
      if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) return n;
    }
    return null;
  }

  _hitTestBadge(wx, wy) {
    for (const n of this.nodes) {
      if (n.kind !== 'project' && n.kind !== 'branch') continue;
      if (this.cachedHiddenIDs.has(n.id)) continue;
      const children = this.childrenMap[n.id] || [];
      if (children.length === 0) continue;
      const r = this._nodeRect(n);
      const bx = r.x + r.w - 4;
      const by = r.y - 4;
      if (Math.sqrt((wx - bx) ** 2 + (wy - by) ** 2) <= 14) return n;
    }
    return null;
  }

  // ── Collapse & Drag ──

  _toggleCollapse(nodeId) {
    if (this.collapsedIDs.has(nodeId)) this.collapsedIDs.delete(nodeId);
    else this.collapsedIDs.add(nodeId);
    this.hiddenDirty = true;
    this.dirty = true;
  }

  _recomputeHidden() {
    if (!this.hiddenDirty) return;
    this.cachedHiddenIDs = new Set();
    const hide = (id) => {
      for (const cid of (this.childrenMap[id] || [])) {
        this.cachedHiddenIDs.add(cid);
        hide(cid);
      }
    };
    for (const id of this.collapsedIDs) hide(id);
    this.hiddenDirty = false;
  }

  _moveNodeSubtree(nodeId, dx, dy) {
    const node = this.nodeMap[nodeId];
    if (!node) return;
    node.x += dx;
    node.y += dy;
    if (!this.positionOffsets[nodeId]) this.positionOffsets[nodeId] = { dx: 0, dy: 0 };
    this.positionOffsets[nodeId].dx += dx;
    this.positionOffsets[nodeId].dy += dy;

    if (node.kind === 'project' || node.kind === 'branch') {
      const moveChildren = (id) => {
        for (const cid of (this.childrenMap[id] || [])) {
          const child = this.nodeMap[cid];
          if (!child) continue;
          child.x += dx;
          child.y += dy;
          if (!this.positionOffsets[cid]) this.positionOffsets[cid] = { dx: 0, dy: 0 };
          this.positionOffsets[cid].dx += dx;
          this.positionOffsets[cid].dy += dy;
          moveChildren(cid);
        }
      };
      moveChildren(nodeId);
    }
  }

  // ── Render Loop ──

  _loop() {
    if (this.dirty) {
      this._draw();
      this.dirty = false;
    }
    requestAnimationFrame(() => this._loop());
  }

  _draw() {
    this._recomputeHidden();
    const ctx = this.ctx;
    const w = window.innerWidth;
    const h = window.innerHeight;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Background
    ctx.fillStyle = Palette.background;
    ctx.fillRect(0, 0, w, h);

    // Camera
    ctx.translate(w / 2 + this.panOffset.x, h / 2 + this.panOffset.y);
    ctx.scale(this.zoomScale, this.zoomScale);

    // Ambient glow around hub
    this._drawAmbientGlow(ctx);

    // Organic tapered connections
    for (const conn of this.connections) {
      if (this.cachedHiddenIDs.has(conn.from) || this.cachedHiddenIDs.has(conn.to)) continue;
      this._drawTaperedConnection(ctx, conn);
    }

    // Nodes: sessions → branches → projects → hub (back to front)
    for (const kind of ['session', 'branch', 'project', 'hub']) {
      for (const node of this.nodes) {
        if (node.kind !== kind || this.cachedHiddenIDs.has(node.id)) continue;
        this._drawNode(ctx, node);
      }
    }

    ctx.restore();
  }

  // ── Ambient Glow ──

  _drawAmbientGlow(ctx) {
    const radius = 900;
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    glow.addColorStop(0, 'rgba(34,197,94,0.06)');
    glow.addColorStop(0.4, 'rgba(34,197,94,0.02)');
    glow.addColorStop(1, 'rgba(34,197,94,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
  }

  // ── Organic Tapered Connections ──

  _drawTaperedConnection(ctx, conn) {
    const from = this.nodeMap[conn.from];
    const to = this.nodeMap[conn.to];
    if (!from || !to) return;

    const taper = TAPER[conn.thickness] || TAPER[1];
    const seed = this._hashStr(conn.from + ':' + conn.to);

    // Quadratic bezier control point with organic wobble
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    const wobbleX = (this._noise(seed) - 0.5) * 25;
    const wobbleY = (this._noise(seed + 3.7) - 0.5) * 25;
    const cpX = midX - dy * 0.22 + wobbleX;
    const cpY = midY + dx * 0.22 + wobbleY;

    // Sample points along the quadratic bezier
    const pts = [];
    for (let i = 0; i <= TAPER_STEPS; i++) {
      const t = i / TAPER_STEPS;
      const mt = 1 - t;
      pts.push({
        x: mt * mt * from.x + 2 * mt * t * cpX + t * t * to.x,
        y: mt * mt * from.y + 2 * mt * t * cpY + t * t * to.y,
      });
    }

    // Build left/right outlines with tapering width
    const leftPts = [];
    const rightPts = [];
    for (let i = 0; i <= TAPER_STEPS; i++) {
      const t = i / TAPER_STEPS;
      // Quadratic ease: stays thick near parent, tapers faster near child
      const w = taper.start + (taper.end - taper.start) * t * t;

      // Tangent direction
      let tx, ty;
      if (i === 0) {
        tx = pts[1].x - pts[0].x;
        ty = pts[1].y - pts[0].y;
      } else if (i === TAPER_STEPS) {
        tx = pts[TAPER_STEPS].x - pts[TAPER_STEPS - 1].x;
        ty = pts[TAPER_STEPS].y - pts[TAPER_STEPS - 1].y;
      } else {
        tx = pts[i + 1].x - pts[i - 1].x;
        ty = pts[i + 1].y - pts[i - 1].y;
      }

      // Normal (perpendicular)
      const len = Math.sqrt(tx * tx + ty * ty) || 1;
      const nx = (-ty / len) * w / 2;
      const ny = (tx / len) * w / 2;

      leftPts.push({ x: pts[i].x + nx, y: pts[i].y + ny });
      rightPts.push({ x: pts[i].x - nx, y: pts[i].y - ny });
    }

    // Build the filled shape path
    const buildPath = () => {
      ctx.beginPath();
      ctx.moveTo(leftPts[0].x, leftPts[0].y);
      for (let i = 1; i <= TAPER_STEPS; i++) ctx.lineTo(leftPts[i].x, leftPts[i].y);
      for (let i = TAPER_STEPS; i >= 0; i--) ctx.lineTo(rightPts[i].x, rightPts[i].y);
      ctx.closePath();
    };

    // Glow pass
    ctx.save();
    ctx.shadowColor = hexToRGBA(conn.color, 0.35);
    ctx.shadowBlur = taper.start * 0.8;
    buildPath();
    ctx.fillStyle = hexToRGBA(conn.color, 0.15);
    ctx.fill();
    ctx.restore();

    // Solid fill with gradient from bright to slightly dimmer
    buildPath();
    const grad = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
    grad.addColorStop(0, hexToRGBA(conn.color, 0.8));
    grad.addColorStop(1, hexToRGBA(conn.color, 0.35));
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // ── Node Drawing ──

  _drawNode(ctx, node) {
    switch (node.kind) {
      case 'hub': this._drawHub(ctx, node); break;
      case 'project': this._drawProject(ctx, node); break;
      case 'branch': this._drawBranch(ctx, node); break;
      case 'session': this._drawSession(ctx, node); break;
    }
  }

  _drawHub(ctx, node) {
    const r = this._nodeRect(node);
    ctx.save();

    // Strong outer glow
    ctx.shadowColor = hexToRGBA(Palette.green, 0.5);
    ctx.shadowBlur = 50;

    // Gradient fill
    const grad = ctx.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
    grad.addColorStop(0, '#2DD868');
    grad.addColorStop(1, '#1AA34A');
    ctx.fillStyle = grad;
    this._roundRect(ctx, r.x, r.y, r.w, r.h, r.r);
    ctx.fill();

    // Inner highlight line
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    this._roundRect(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 2, r.r - 1);
    ctx.stroke();

    ctx.font = 'bold 15px "JetBrains Mono", monospace';
    ctx.fillStyle = Palette.hubText;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(node.label, node.x, node.y);
    ctx.restore();
  }

  _drawProject(ctx, node) {
    const r = this._nodeRect(node);
    ctx.save();

    // Colored glow
    ctx.shadowColor = hexToRGBA(node.color, 0.3);
    ctx.shadowBlur = 24;

    // Tinted fill: dark base blended with project color
    ctx.fillStyle = this._tintSurface(node.color, 0.12);
    this._roundRect(ctx, r.x, r.y, r.w, r.h, r.r);
    ctx.fill();

    ctx.shadowColor = 'transparent';

    // Colored border
    ctx.strokeStyle = hexToRGBA(node.color, 0.7);
    ctx.lineWidth = 2;
    this._roundRect(ctx, r.x, r.y, r.w, r.h, r.r);
    ctx.stroke();

    ctx.font = '600 13px "JetBrains Mono", monospace';
    ctx.fillStyle = Palette.textPrimary;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this._truncate(node.label, r.w - 30, 13), node.x, node.y);

    ctx.restore();
    this._drawCollapseBadge(ctx, node, r);
  }

  _drawBranch(ctx, node) {
    const r = this._nodeRect(node);
    ctx.save();

    // Subtle glow
    ctx.shadowColor = hexToRGBA(node.color, 0.15);
    ctx.shadowBlur = 12;

    ctx.fillStyle = this._tintSurface(node.color, 0.08);
    this._roundRect(ctx, r.x, r.y, r.w, r.h, r.r);
    ctx.fill();

    ctx.shadowColor = 'transparent';

    ctx.strokeStyle = hexToRGBA(node.color, 0.45);
    ctx.lineWidth = 1;
    this._roundRect(ctx, r.x, r.y, r.w, r.h, r.r);
    ctx.stroke();

    ctx.font = '500 11px "JetBrains Mono", monospace';
    ctx.fillStyle = Palette.textSecondary;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this._truncate(node.label, r.w - 20, 11), node.x, node.y);

    ctx.restore();
    this._drawCollapseBadge(ctx, node, r);
  }

  _drawSession(ctx, node) {
    const session = node.data;
    if (!session) return;

    const isArchived = session.status === 'archived';
    const r = this._nodeRect(node);
    const sColor = statusColor(session.status);
    const LINE_H = 13;

    ctx.save();

    // Glow on active cards
    if (!isArchived) {
      ctx.shadowColor = hexToRGBA(sColor, 0.3);
      ctx.shadowBlur = 20;
    }

    // Card fill
    ctx.fillStyle = isArchived ? Palette.archivedCardFill : Palette.surface;
    this._roundRect(ctx, r.x, r.y, r.w, r.h, r.r);
    ctx.fill();

    ctx.shadowColor = 'transparent';

    // Border
    ctx.strokeStyle = isArchived ? hexToRGBA(Palette.border, 0.5) : hexToRGBA(sColor, 0.5);
    ctx.lineWidth = isArchived ? 0.5 : 1;
    this._roundRect(ctx, r.x, r.y, r.w, r.h, r.r);
    ctx.stroke();

    // Left accent stripe
    ctx.fillStyle = sColor;
    this._roundRect(ctx, r.x, r.y, 5, r.h, { tl: r.r, bl: r.r, tr: 0, br: 0 });
    ctx.fill();

    // Text content
    const textX = r.x + 16;
    const maxTextW = r.w - 28;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    if (isArchived) {
      ctx.font = '400 10px "JetBrains Mono", monospace';
      ctx.fillStyle = Palette.textMuted;
      const lines = this._wrapText(session.prompt || '', maxTextW, 10, 2);
      let y = r.y + 8;
      for (const line of lines) {
        ctx.fillText(line, textX, y);
        y += LINE_H;
      }
    } else {
      let y = r.y + 10;

      // Status label
      ctx.font = '600 9px "JetBrains Mono", monospace';
      ctx.fillStyle = sColor;
      ctx.fillText(session.status.toUpperCase(), textX, y);
      y += LINE_H + 2;

      // Prompt (up to 3 lines)
      ctx.font = '500 10px "JetBrains Mono", monospace';
      ctx.fillStyle = Palette.textPrimary;
      const promptLines = this._wrapText('> ' + (session.prompt || ''), maxTextW, 10, 3);
      for (const line of promptLines) {
        ctx.fillText(line, textX, y);
        y += LINE_H;
      }
      y += 4;

      // Summary (up to 5 lines)
      ctx.font = '400 10px "JetBrains Mono", monospace';
      ctx.fillStyle = Palette.textSecondary;
      const summaryLines = this._wrapText(session.summary || '', maxTextW, 10, 5);
      for (const line of summaryLines) {
        ctx.fillText(line, textX, y);
        y += LINE_H;
      }
    }

    ctx.restore();
  }

  _drawCollapseBadge(ctx, node, rect) {
    const children = this.childrenMap[node.id] || [];
    if (children.length === 0) return;

    const bx = rect.x + rect.w - 4;
    const by = rect.y - 4;
    const isCollapsed = this.collapsedIDs.has(node.id);

    let count = 0;
    const countAll = (id) => {
      const ch = this.childrenMap[id] || [];
      count += ch.length;
      ch.forEach(countAll);
    };
    countAll(node.id);

    ctx.save();

    // Badge glow
    ctx.shadowColor = hexToRGBA(node.color, 0.4);
    ctx.shadowBlur = 8;

    ctx.beginPath();
    ctx.arc(bx, by, 13, 0, Math.PI * 2);
    ctx.fillStyle = hexToRGBA(node.color, 0.9);
    ctx.fill();

    ctx.shadowColor = 'transparent';
    ctx.font = 'bold 9px "JetBrains Mono", monospace';
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(isCollapsed ? `+${count}` : '\u2212', bx, by);
    ctx.restore();
  }

  // ── Utilities ──

  _noise(seed) {
    const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  _hashStr(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return h;
  }

  _tintSurface(hex, amount) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    // Surface base: #171717 = (23, 23, 23)
    const mr = Math.round(23 + (r - 23) * amount);
    const mg = Math.round(23 + (g - 23) * amount);
    const mb = Math.round(23 + (b - 23) * amount);
    return `rgb(${mr},${mg},${mb})`;
  }

  _roundRect(ctx, x, y, w, h, r) {
    if (typeof r === 'number') {
      r = { tl: r, tr: r, br: r, bl: r };
    }
    ctx.beginPath();
    ctx.moveTo(x + r.tl, y);
    ctx.lineTo(x + w - r.tr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r.tr);
    ctx.lineTo(x + w, y + h - r.br);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r.br, y + h);
    ctx.lineTo(x + r.bl, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r.bl);
    ctx.lineTo(x, y + r.tl);
    ctx.quadraticCurveTo(x, y, x + r.tl, y);
    ctx.closePath();
  }

  _wrapText(text, maxWidth, fontSize, maxLines) {
    const charW = fontSize * 0.6;
    const maxChars = Math.floor(maxWidth / charW);
    if (maxChars <= 0) return [''];

    const lines = [];
    let remaining = text;

    while (remaining.length > 0 && lines.length < maxLines) {
      if (remaining.length <= maxChars) {
        lines.push(remaining);
        break;
      }

      // Find a word break point near maxChars
      let breakAt = maxChars;
      const spaceIdx = remaining.lastIndexOf(' ', maxChars);
      if (spaceIdx > maxChars * 0.4) breakAt = spaceIdx;

      if (lines.length === maxLines - 1) {
        // Last allowed line — truncate with ellipsis
        lines.push(remaining.slice(0, maxChars - 1) + '\u2026');
        break;
      }

      lines.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).trimStart();
    }

    return lines.length > 0 ? lines : [''];
  }

  _truncate(text, maxWidth, fontSize) {
    const charW = fontSize * 0.6;
    const maxChars = Math.floor(maxWidth / charW);
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars - 1) + '\u2026';
  }
}
