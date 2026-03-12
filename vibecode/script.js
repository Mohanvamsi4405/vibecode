// ============================================================
// VibeCode — Core Application
// ============================================================

// ── State Store ──────────────────────────────────────────────
const Store = {
    state: {
        files: {},
        openFiles: [],
        activeFile: '',
        activeProject: '',
        activeModel: 'llama-3.3-70b-versatile',
        chatHistory: [],
        expandedFolders: {},
        previewMode: 'static',
        previewPort: 8000
    },

    async load() {
        try {
            const saved = localStorage.getItem('vc_state');
            if (saved) {
                const s = JSON.parse(saved);
                this.state.openFiles = s.openFiles || [];
                this.state.activeFile = s.activeFile || '';
                this.state.activeProject = s.activeProject || '';
                this.state.activeModel = s.activeModel || 'llama-3.3-70b-versatile';
                this.state.chatHistory = s.chatHistory || [];
                this.state.expandedFolders = s.expandedFolders || {};
            }

            const res = await fetch('/api/fs/tree');
            if (res.ok) {
                const data = await res.json();
                this.state.files = (data && typeof data === 'object') ? data : {};
            }

            // Clean up stale open files
            this.state.openFiles = this.state.openFiles.filter(f => f in this.state.files);

            // Pick a default active file
            if (!this.state.activeFile || !(this.state.activeFile in this.state.files)) {
                this.state.activeFile =
                    this.state.files['index.html'] ? 'index.html' :
                        (Object.keys(this.state.files)[0] || '');
            }
            if (this.state.activeFile && !this.state.openFiles.includes(this.state.activeFile)) {
                this.state.openFiles.push(this.state.activeFile);
            }

            UI.renderFileTree();
            UI.renderTabs();
            if (this.state.activeFile) UI.loadFile(this.state.activeFile);

        } catch (e) { console.error('Load error', e); }
    },

    save() {
        try {
            localStorage.setItem('vc_state', JSON.stringify({
                openFiles: this.state.openFiles,
                activeFile: this.state.activeFile,
                activeProject: this.state.activeProject,
                activeModel: this.state.activeModel,
                chatHistory: this.state.chatHistory,
                expandedFolders: this.state.expandedFolders,
                previewMode: this.state.previewMode,
                previewPort: this.state.previewPort
            }));
        } catch (e) { /* storage full */ }
    },

    async updateFile(path, content) {
        this.state.files[path] = content;
        try {
            await fetch('/api/fs/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path, content })
            });
        } catch (e) { console.error('Save failed', e); }
        this.save();
    },

    async deleteFile(path) {
        const prefix = path + '/';
        Object.keys(this.state.files)
            .filter(f => f === path || f.startsWith(prefix))
            .forEach(f => delete this.state.files[f]);

        this.state.openFiles = this.state.openFiles.filter(f => f !== path && !f.startsWith(prefix));
        if (this.state.activeFile === path || this.state.activeFile.startsWith(prefix)) {
            this.state.activeFile = this.state.openFiles[0] || '';
        }

        try {
            await fetch('/api/fs/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path })
            });
        } catch (e) { console.error('Delete failed', e); }

        this.save();
        UI.renderFileTree();
        UI.renderTabs();
        UI.loadFile(this.state.activeFile);
    },

    async renameFile(oldPath, newPath) {
        try {
            const res = await fetch('/api/fs/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: oldPath, content: newPath })
            });
            if (!res.ok) throw new Error(await res.text());
            await this.load();
        } catch (e) {
            console.error('Rename failed', e);
            alert('Rename failed: ' + e.message);
        }
    }
};
window.Store = Store;

// ── UI ───────────────────────────────────────────────────────
const UI = {
    els: {},

    init() {
        const ids = [
            'code-editor', 'line-numbers', 'file-tree',
            'tabs-container', 'preview-frame', 'chat-messages',
            'chat-input', 'preview-url-bar',
            'cursor-pos', 'cursor-pos-bar', 'file-lang',
            'status-file-count', 'active-crumb', 'btn-toggle-proxy', 'preview-port-input'
        ];
        ids.forEach(id => { this.els[id] = document.getElementById(id); });

        this.setupResizers();
        this.setupScrollSync();
        this.setupCursorTracking();
        this.renderFileTree();
        this.renderTabs();
        if (this.els['preview-port-input']) {
            this.els['preview-port-input'].value = Store.state.previewPort || 8000;
            this.els['preview-port-input'].addEventListener('change', (e) => {
                let port = parseInt(e.target.value);
                if (isNaN(port) || port < 1 || port > 65535) port = 8000;
                Store.state.previewPort = port;
                e.target.value = port;
                Store.save();
                this.updatePreview();
            });
        }
        if (Store.state.activeFile) this.loadFile(Store.state.activeFile);
    },

    // ── Scroll sync: line numbers track editor ────────────────
    setupScrollSync() {
        const ed = this.els['code-editor'];
        const ln = this.els['line-numbers'];
        if (ed && ln) ed.addEventListener('scroll', () => { ln.scrollTop = ed.scrollTop; });
    },

    // ── Cursor tracking ───────────────────────────────────────
    setupCursorTracking() {
        const ed = this.els['code-editor'];
        if (!ed) return;
        const update = () => {
            const text = ed.value.substring(0, ed.selectionStart);
            const lines = text.split('\n');
            const ln = lines.length;
            const col = lines[lines.length - 1].length + 1;
            const label = `Ln ${ln}, Col ${col}`;
            if (this.els['cursor-pos']) this.els['cursor-pos'].textContent = label;
            if (this.els['cursor-pos-bar']) this.els['cursor-pos-bar'].textContent = label;
        };
        ed.addEventListener('click', update);
        ed.addEventListener('keyup', update);
        ed.addEventListener('input', update);
    },

    // ── Panel resizers ────────────────────────────────────────
    setupResizers() {
        const drag = (handleId, targetId, axis, invert = false) => {
            const handle = document.getElementById(handleId);
            const target = document.getElementById(targetId);
            if (!handle || !target) return;
            handle.addEventListener('mousedown', e => {
                e.preventDefault();
                const startPos = axis === 'x' ? e.clientX : e.clientY;
                const startSize = axis === 'x' ? target.offsetWidth : target.offsetHeight;
                const onMove = e => {
                    const delta = (axis === 'x' ? e.clientX : e.clientY) - startPos;
                    const newSize = invert ? startSize - delta : startSize + delta;
                    const min = axis === 'x' ? 140 : 80;
                    if (axis === 'x') target.style.width = Math.max(min, newSize) + 'px';
                    else target.style.height = Math.max(min, newSize) + 'px';
                };
                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        };
        drag('resizer-sidebar', 'sidebar-panel', 'x');
        drag('resizer-aux', 'aux-panel', 'x', true);
    },

    // ── File helpers ──────────────────────────────────────────
    getFileIcon(name) {
        if (name.endsWith('.html')) return { i: 'file-code', c: '#e34c26' };
        if (name.endsWith('.css')) return { i: 'paintbrush', c: '#7c3aed' };
        if (name.endsWith('.js')) return { i: 'zap', c: '#eab308' };
        if (name.endsWith('.py')) return { i: 'file-code', c: '#3b82f6' };
        if (name.endsWith('.json')) return { i: 'braces', c: '#cbcb41' };
        if (name.endsWith('.md')) return { i: 'book-open', c: '#60a5fa' };
        if (name.endsWith('.txt')) return { i: 'file-text', c: '#71717a' };
        if (name.endsWith('.toml') || name.endsWith('.cfg') || name.endsWith('.ini'))
            return { i: 'settings', c: '#f59e0b' };
        if (name.endsWith('.yaml') || name.endsWith('.yml'))
            return { i: 'file-text', c: '#22d3ee' };
        if (name.match(/\.(png|jpg|svg|gif|webp|ico)$/)) return { i: 'image', c: '#4ade80' };
        if (name === 'requirements.txt') return { i: 'package', c: '#3b82f6' };
        return { i: 'file', c: '#71717a' };
    },

    getLang(name) {
        if (name.endsWith('.html')) return 'HTML';
        if (name.endsWith('.css')) return 'CSS';
        if (name.endsWith('.js')) return 'JavaScript';
        if (name.endsWith('.py')) return 'Python';
        if (name.endsWith('.json')) return 'JSON';
        if (name.endsWith('.md')) return 'Markdown';
        if (name.endsWith('.txt')) return 'Text';
        if (name.endsWith('.toml')) return 'TOML';
        if (name.endsWith('.yaml') || name.endsWith('.yml')) return 'YAML';
        return '—';
    },

    // ── File tree ─────────────────────────────────────────────
    renderFileTree() {
        const tree = this.buildTree(Store.state.files);
        if (this.els['file-tree']) {
            this.els['file-tree'].innerHTML = this.renderNode(tree, 0);
            lucide.createIcons();
        }
        // Update file count in status bar
        const count = Object.keys(Store.state.files).length;
        if (this.els['status-file-count']) {
            this.els['status-file-count'].textContent = `${count} file${count !== 1 ? 's' : ''}`;
        }
    },

    buildTree(files) {
        const root = { type: 'folder', name: 'root', children: {} };
        Object.keys(files).sort().forEach(path => {
            const parts = path.split('/');
            let cur = root;
            parts.forEach((part, i) => {
                if (i === parts.length - 1) {
                    cur.children[part] = { type: 'file', name: part, path };
                } else {
                    if (!cur.children[part]) {
                        cur.children[part] = {
                            type: 'folder', name: part,
                            path: parts.slice(0, i + 1).join('/'),
                            children: {}
                        };
                    }
                    cur = cur.children[part];
                }
            });
        });
        return root;
    },

    renderNode(node, depth) {
        if (node.name === 'root') {
            return Object.values(node.children).map(c => this.renderNode(c, 0)).join('');
        }
        const isFolder = node.type === 'folder';
        const isExpanded = Store.state.expandedFolders[node.path];
        const isActive = Store.state.activeFile === node.path;
        const fi = isFolder ? null : this.getFileIcon(node.name);
        const indent = depth * 14 + 8;

        let html = `<div class="file-node ${isActive ? 'active' : ''}"
             data-path="${node.path}" data-type="${node.type}"
             style="padding-left:${indent}px">
            <div style="display:flex;align-items:center;flex:1;min-width:0;gap:2px;">
                ${isFolder
                ? `<i data-lucide="chevron-right" class="folder-arrow ${isExpanded ? 'expanded' : ''}"></i>
                       <i data-lucide="folder" class="icon" style="color:#eab308;width:14px;height:14px;margin-right:5px;flex-shrink:0"></i>`
                : `<i data-lucide="${fi.i}" class="icon" style="color:${fi.c};width:14px;height:14px;margin-right:5px;flex-shrink:0"></i>`
            }
                <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${node.name}</span>
            </div>
            <div class="file-actions">
                <i data-lucide="trash-2" class="delete-icon"></i>
            </div>
        </div>`;

        if (isFolder && isExpanded) {
            html += Object.values(node.children).map(c => this.renderNode(c, depth + 1)).join('');
        }
        return html;
    },

    // ── Tabs ──────────────────────────────────────────────────
    renderTabs() {
        const container = this.els['tabs-container'];
        if (!container) return;
        container.innerHTML = Store.state.openFiles.map(f => {
            const name = f.split('/').pop();
            const fi = this.getFileIcon(name);
            return `<div class="tab ${f === Store.state.activeFile ? 'active' : ''}" data-path="${f}">
                <i data-lucide="${fi.i}" style="color:${fi.c}"></i>
                <span style="max-width:120px;overflow:hidden;text-overflow:ellipsis;">${name}</span>
                <span class="tab-close" data-close="${f}">✕</span>
            </div>`;
        }).join('');
        lucide.createIcons();
    },

    // ── Load file into editor ─────────────────────────────────
    loadFile(path) {
        if (!path) {
            if (this.els['code-editor']) this.els['code-editor'].value = '';
            if (this.els['line-numbers']) this.els['line-numbers'].textContent = '1';
            return;
        }
        Store.state.activeFile = path;

        // Auto-expand parent folders
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
            const folderPath = parts.slice(0, i).join('/');
            Store.state.expandedFolders[folderPath] = true;
        }
        Store.save();

        const content = Store.state.files[path] || '';
        if (this.els['code-editor']) {
            this.els['code-editor'].value = content;
            this.els['code-editor'].scrollTop = 0;
        }
        if (this.els['line-numbers']) this.els['line-numbers'].scrollTop = 0;

        this.updateLineNumbers();

        // Breadcrumb + title
        const name = path.split('/').pop();
        if (this.els['active-crumb']) this.els['active-crumb'].textContent = path;
        if (this.els['file-lang']) this.els['file-lang'].textContent = this.getLang(name);
        document.title = `${name} — VibeCode`;

        this.renderFileTree();   // sync sidebar highlight with active file
        this.renderTabs();
        this.updatePreview();
    },

    // ── Line numbers ──────────────────────────────────────────
    updateLineNumbers() {
        const ed = this.els['code-editor'];
        const ln = this.els['line-numbers'];
        if (!ed || !ln) return;
        const count = ed.value.split('\n').length;
        ln.textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n');
        ln.scrollTop = ed.scrollTop;
    },

    // ── Preview ───────────────────────────────────────────────
    updatePreview() {
        const frame = this.els['preview-frame'];
        if (!frame) return;

        const active = Store.state.activeFile;
        const files = Store.state.files;

        // Python files: show "Run" placeholder instead of preview
        if (active && active.endsWith('.py')) {
            frame.removeAttribute('src');
            frame.srcdoc = `<html><body style="margin:0;background:#0a0a0f;font-family:system-ui,sans-serif;
                display:flex;justify-content:center;align-items:center;height:100vh;text-align:center;color:#52525b;">
                <div><div style="font-size:56px;margin-bottom:16px">🐍</div>
                <p style="color:#a1a1aa;font-size:14px">Python file — click
                <strong style="color:#8b5cf6;cursor:pointer" onclick="window.parent.postMessage('run-python','*')">▶ Run</strong>
                to execute</p></div></body></html>`;
            if (this.els['preview-url-bar']) this.els['preview-url-bar'].textContent = active;
            return;
        }

        let target = '';

        if (active && active.endsWith('.html')) {
            target = active;
        } else {
            const folder = active && active.includes('/')
                ? active.substring(0, active.lastIndexOf('/'))
                : '';
            target =
                (folder && files[`${folder}/index.html`] ? `${folder}/index.html` : null) ||
                (files['index.html'] ? 'index.html' : null) ||
                Object.keys(files).find(f => f.endsWith('index.html')) ||
                '';
        }

        if (!target) {
            frame.srcdoc = `<html style="background:#0a0a0f;color:#52525b;font-family:sans-serif;
                display:flex;justify-content:center;align-items:center;height:100%;margin:0;">
                <body><div style="text-align:center;"><div style="font-size:40px;margin-bottom:12px;">📄</div>
                <p>No HTML file to preview</p></div></body></html>`;
            if (this.els['preview-url-bar']) this.els['preview-url-bar'].textContent = 'No preview';
            return;
        }

        const url = Store.state.previewMode === 'proxy'
            ? `/proxy/${Store.state.previewPort || 8000}/`
            : `/project/${target}`;

        if (this.els['preview-url-bar']) this.els['preview-url-bar'].textContent = url;
        frame.removeAttribute('srcdoc');
        if (frame.getAttribute('src') !== url) frame.src = url;

        // Update toggle button appearance
        const btn = document.getElementById('btn-toggle-proxy');
        if (btn) {
            btn.classList.toggle('active', Store.state.previewMode === 'proxy');
            btn.title = Store.state.previewMode === 'proxy'
                ? 'Switch to Static Preview'
                : 'Switch to Server Preview (for FastAPI/Backends)';
        }
    },

    reloadPreview() {
        if (Store.state.activeFile?.endsWith('.py')) return;
        const frame = this.els['preview-frame'];
        if (!frame) return;
        try {
            frame.contentWindow.location.reload();
        } catch {
            const src = frame.src;
            if (src && src !== 'about:blank') {
                frame.src = src.split('?')[0] + '?t=' + Date.now();
            }
        }
    },

    // ── Context menu ──────────────────────────────────────────
    showContextMenu(x, y, path, type) {
        const menu = document.getElementById('context-menu');
        if (!menu) return;
        let html = '';
        if (type === 'folder' || type === 'root') {
            html += `<div class="ctx-item" onclick="UI.handleCtx('new_file','${path}')">
                        <i data-lucide="file-plus"></i> New File</div>
                     <div class="ctx-item" onclick="UI.handleCtx('new_folder','${path}')">
                        <i data-lucide="folder-plus"></i> New Folder</div>
                     <div class="ctx-sep"></div>`;
        }
        if (type !== 'root') {
            html += `<div class="ctx-item" onclick="UI.handleCtx('rename','${path}')">
                        <i data-lucide="pencil"></i> Rename</div>
                     <div class="ctx-item danger" onclick="UI.handleCtx('delete','${path}')">
                        <i data-lucide="trash-2"></i> Delete</div>`;
        }
        menu.innerHTML = html;
        menu.style.cssText = `display:block;left:${x}px;top:${y}px;`;
        lucide.createIcons();
    },

    hideContextMenu() {
        const m = document.getElementById('context-menu');
        if (m) m.style.display = 'none';
    },

    async handleCtx(action, path) {
        this.hideContextMenu();
        const base = path === 'root' ? '' : path;

        if (action === 'new_file') {
            const name = prompt('New file path:', base ? base + '/' : '');
            if (name) {
                await Store.updateFile(name, '');
                Store.state.openFiles.push(name);
                UI.renderFileTree();
                UI.loadFile(name);
            }
        } else if (action === 'new_folder') {
            const name = prompt('New folder name:', base ? base + '/' : '');
            if (name) {
                await Store.updateFile(name.replace(/\/$/, '') + '/.gitkeep', '');
                UI.renderFileTree();
            }
        } else if (action === 'rename') {
            const name = prompt('Rename to:', path);
            if (name && name !== path) {
                await Store.renameFile(path, name);
                if (Store.state.activeFile === path) Store.state.activeFile = name;
                const i = Store.state.openFiles.indexOf(path);
                if (i !== -1) Store.state.openFiles[i] = name;
                Store.save();
                UI.renderTabs();
                UI.loadFile(Store.state.activeFile);
            }
        } else if (action === 'delete') {
            if (confirm(`Delete "${path}"?`)) await Store.deleteFile(path);
        }
    }
};
window.UI = UI;

// ============================================================
// Autocomplete
// ============================================================
const AC = {
    el: null, items: [], selected: -1,

    init() { this.el = document.getElementById('autocomplete-dropdown'); },

    show(completions, pos) {
        if (!this.el || !completions.length) { this.hide(); return; }
        this.items = completions;
        this.selected = 0;
        this.el.innerHTML = completions.map((c, i) =>
            `<div class="ac-item ${i === 0 ? 'active' : ''}" data-i="${i}">
                <span class="ac-type ${c.type}">${c.type}</span>
                <span class="ac-name">${c.name}</span>
                ${c.description ? `<span class="ac-desc">${c.description}</span>` : ''}
             </div>`
        ).join('');
        const ddH = Math.min(completions.length * 29, 220);
        const posTop = (pos.top + ddH > window.innerHeight)
            ? pos.top - ddH - 4 : pos.top + 4;
        this.el.style.cssText =
            `display:block;top:${Math.max(4, posTop)}px;left:${Math.min(pos.left, window.innerWidth - 250)}px`;
    },

    hide() { if (this.el) this.el.style.display = 'none'; this.items = []; this.selected = -1; },

    move(dir) {
        if (!this.items.length) return false;
        this.selected = (this.selected + dir + this.items.length) % this.items.length;
        this.el.querySelectorAll('.ac-item').forEach((el, i) => el.classList.toggle('active', i === this.selected));
        this.el.querySelectorAll('.ac-item')[this.selected]?.scrollIntoView({ block: 'nearest' });
        return true;
    },

    accept(textarea) {
        if (!this.items[this.selected]) return false;
        const name = this.items[this.selected].name;
        const pos = textarea.selectionStart;
        const before = textarea.value.substring(0, pos);
        // Replace only the last identifier segment (after last dot or space)
        const m = before.match(/[\w]*$/);
        const from = pos - (m ? m[0].length : 0);
        textarea.value = textarea.value.substring(0, from) + name + textarea.value.substring(pos);
        textarea.selectionStart = textarea.selectionEnd = from + name.length;
        textarea.dispatchEvent(new Event('input'));
        this.hide();
        return true;
    }
};

// Keyword fallback for JS / CSS / HTML
const LOCAL_KWORDS = {
    js: ['const', 'let', 'var', 'function', 'class', 'return', 'if', 'else', 'for', 'while', 'switch', 'case',
        'async', 'await', 'import', 'export', 'default', 'new', 'this', 'typeof', 'instanceof',
        'try', 'catch', 'finally', 'throw', 'true', 'false', 'null', 'undefined', 'NaN',
        'console.log', 'document.getElementById', 'document.querySelector', 'addEventListener',
        'fetch', 'Promise', 'Array', 'Object', 'JSON.stringify', 'JSON.parse',
        'Math.floor', 'Math.round', 'Math.random', 'parseInt', 'parseFloat',
        'forEach', 'map', 'filter', 'reduce', 'find', 'includes', 'push', 'pop', 'slice', 'splice',
        'setTimeout', 'setInterval', 'clearTimeout'].map(n => ({ name: n, type: 'keyword', description: '' })),
    css: ['display', 'flex', 'grid', 'position', 'absolute', 'relative', 'fixed', 'sticky',
        'width', 'height', 'margin', 'padding', 'border', 'border-radius', 'background', 'color',
        'font-size', 'font-weight', 'font-family', 'line-height', 'text-align', 'text-decoration',
        'transform', 'transition', 'animation', 'opacity', 'overflow', 'cursor', 'z-index',
        'justify-content', 'align-items', 'flex-direction', 'flex-wrap', 'gap',
        'grid-template-columns', 'box-shadow', 'pointer-events', 'user-select',
        '@media', '@keyframes', ':hover', ':focus', ':active', '::before', '::after',
        'var(--', 'rgba(', 'linear-gradient(', 'radial-gradient('].map(n => ({ name: n, type: 'keyword', description: '' })),
    html: ['div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'button', 'input', 'textarea',
        'select', 'option', 'form', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'thead', 'tbody',
        'nav', 'header', 'footer', 'main', 'section', 'article', 'aside', 'img', 'video',
        'canvas', 'svg', 'iframe', 'class=', 'id=', 'href=', 'src=', 'style=', 'type=',
        'placeholder=', 'onclick=', 'data-', 'aria-label='].map(n => ({ name: n, type: 'keyword', description: '' }))
};

function getCaretPos(textarea) {
    const pos = textarea.selectionStart;
    const lines = textarea.value.substring(0, pos).split('\n');
    const lineN = lines.length - 1;
    const cs = getComputedStyle(textarea);
    const lh = parseFloat(cs.lineHeight) || 20.8;
    const pt = parseFloat(cs.paddingTop) || 10;
    const pl = parseFloat(cs.paddingLeft) || 14;
    const fw = parseFloat(cs.fontSize) * 0.601; // monospace char width ratio
    const rect = textarea.getBoundingClientRect();
    return {
        top: Math.min(rect.top + pt + (lineN + 1) * lh - textarea.scrollTop, rect.bottom - 10),
        left: Math.min(rect.left + pl + lines[lineN].length * fw - textarea.scrollLeft, rect.right - 20)
    };
}

let _acTimer = null;
async function triggerComplete(textarea) {
    clearTimeout(_acTimer);
    const af = Store.state.activeFile || '';
    const lang = af.endsWith('.py') ? 'python' : af.endsWith('.js') ? 'js'
        : af.endsWith('.css') ? 'css' : af.endsWith('.html') ? 'html' : null;
    if (!lang) { AC.hide(); return; }

    const pos = textarea.selectionStart;
    const before = textarea.value.substring(0, pos);
    const word = (before.match(/[\w.]+$/) || [''])[0];
    if (word.length < 1 && !before.endsWith('.')) { AC.hide(); return; }

    _acTimer = setTimeout(async () => {
        let completions = [];
        if (lang === 'python') {
            try {
                const text = textarea.value;
                const ls = text.substring(0, pos).split('\n');
                const res = await fetch('/api/complete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: text, line: ls.length, col: ls[ls.length - 1].length, path: af })
                });
                if (res.ok) completions = await res.json();
            } catch { /* ignore */ }
            // Fallback: simple Python keyword list if backend returned nothing
            if (!completions.length) {
                const pyKW = ['def', 'class', 'import', 'from', 'return', 'if', 'elif', 'else', 'for',
                    'while', 'try', 'except', 'finally', 'with', 'as', 'pass', 'break', 'continue',
                    'True', 'False', 'None', 'and', 'or', 'not', 'in', 'is', 'lambda', 'yield',
                    'print', 'input', 'len', 'range', 'int', 'str', 'float', 'list', 'dict', 'set',
                    'tuple', 'type', 'isinstance', 'open', 'enumerate', 'zip', 'map', 'filter',
                    'sorted', 'sum', 'min', 'max', 'abs', 'round', 'super', 'self'].map(n => ({ name: n, type: 'keyword', description: 'Python' }));
                completions = word ? pyKW.filter(c => c.name.startsWith(word)).slice(0, 12) : pyKW.slice(0, 10);
            }
        } else {
            const pool = LOCAL_KWORDS[lang] || [];
            completions = word ? pool.filter(c => c.name.toLowerCase().startsWith(word.toLowerCase())).slice(0, 12)
                : pool.slice(0, 10);
        }
        if (completions.length) AC.show(completions, getCaretPos(textarea));
        else AC.hide();
    }, lang === 'python' ? 380 : 150);
}

// ============================================================
// Bootstrap
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    AC.init();
    if (typeof hljs !== 'undefined') {
        hljs.configure({ ignoreUnescapedHTML: true });
    }
    // Fetch global config then init UI
    fetch('/api/config').then(r => r.json()).then(cfg => {
        window._ideConfig = cfg;
        Store.load().then(() => UI.init());
    }).catch(() => {
        Store.load().then(() => UI.init());
    });

    // Close context menu on click
    document.addEventListener('click', () => UI.hideContextMenu());

    // ── Mobile: close sidebar when backdrop is tapped ────────
    document.getElementById('sidebar-backdrop')?.addEventListener('click', () => {
        document.body.classList.remove('sidebar-open');
    });

    // ── Mobile: close sidebar when a file is opened ───────────
    document.getElementById('file-tree')?.addEventListener('click', e => {
        const node = e.target.closest('.file-node');
        if (node && node.dataset.type === 'file') {
            document.body.classList.remove('sidebar-open');
        }
    });

    // ── Sidebar context menu ──────────────────────────────────
    document.getElementById('sidebar-panel')?.addEventListener('contextmenu', e => {
        e.preventDefault();
        const node = e.target.closest('.file-node');
        if (node) UI.showContextMenu(e.pageX, e.pageY, node.dataset.path, node.dataset.type);
        else UI.showContextMenu(e.pageX, e.pageY, 'root', 'root');
    });

    // ── Delegated click handler ───────────────────────────────
    document.body.addEventListener('click', async e => {
        const t = e.target;

        // Delete icon in file tree
        if (t.closest('.delete-icon')) {
            e.stopPropagation();
            const node = t.closest('.file-node');
            if (node) UI.handleCtx('delete', node.dataset.path);
            return;
        }

        // File node click
        const fileNode = t.closest('.file-node');
        if (fileNode && !t.closest('.file-actions')) {
            const path = fileNode.dataset.path;
            const type = fileNode.dataset.type;
            if (type === 'folder') {
                Store.state.expandedFolders[path] = !Store.state.expandedFolders[path];
                Store.save();
                UI.renderFileTree();
            } else {
                if (!Store.state.openFiles.includes(path)) Store.state.openFiles.push(path);
                UI.loadFile(path);
            }
            return;
        }

        // Tab click
        const tab = t.closest('.tab');
        if (tab && !t.classList.contains('tab-close')) {
            UI.loadFile(tab.dataset.path);
            return;
        }

        // Tab close
        if (t.classList.contains('tab-close')) {
            e.stopPropagation();
            const path = t.dataset.close;
            Store.state.openFiles = Store.state.openFiles.filter(f => f !== path);
            if (Store.state.activeFile === path) {
                Store.state.activeFile = Store.state.openFiles.at(-1) || '';
            }
            Store.save();
            UI.renderTabs();
            UI.loadFile(Store.state.activeFile);
            return;
        }

        // Device controls
        const devBtn = t.closest('.device-controls .icon-btn');
        if (devBtn) {
            document.querySelectorAll('.device-controls .icon-btn').forEach(b => b.classList.remove('active'));
            devBtn.classList.add('active');
            const wrapper = document.getElementById('preview-wrapper');
            if (wrapper) wrapper.className = `device-wrapper ${devBtn.dataset.device}`;
            return;
        }

        // Topbar: View mode tabs
        const modeTab = t.closest('.view-tab');
        if (modeTab) {
            document.querySelectorAll('.view-tab').forEach(b => b.classList.remove('active'));
            modeTab.classList.add('active');
            const mode = modeTab.dataset.mode;
            const editor = document.getElementById('editor-area');
            const preview = document.getElementById('aux-panel');
            const rAux = document.getElementById('resizer-aux');
            if (mode === 'code') {
                if (editor) { editor.style.display = 'flex'; editor.style.flex = '1'; }
                if (preview) { preview.style.display = 'none'; preview.style.flex = ''; }
                if (rAux) rAux.style.display = 'none';
            } else if (mode === 'preview') {
                if (editor) { editor.style.display = 'none'; editor.style.flex = ''; }
                if (preview) { preview.style.display = 'flex'; preview.style.flex = '1'; }
                if (rAux) rAux.style.display = 'none';
            } else { // split
                if (editor) { editor.style.display = 'flex'; editor.style.flex = '1'; }
                if (preview) { preview.style.display = 'flex'; preview.style.flex = '1'; }
                if (rAux) rAux.style.display = window.innerWidth > 768 ? 'block' : 'none';
            }
            return;
        }

        // Topbar: AI Chat → open terminal panel
        // If shell is already alive → open in split so both panes stay visible
        // Toggling when already in aichat/split → close the panel
        if (t.closest('#btn-toggle-chat')) {
            const panel = document.getElementById('terminal-panel');
            const isOpen = panel && panel.style.display !== 'none';
            const alreadyChat = _termMode === 'aichat' || _termMode === 'split';
            if (isOpen && alreadyChat) {
                closeTerminal();
            } else if (_shellWS && _termAlive) {
                // Shell running → show split so user keeps seeing it
                openShellTerminal('split');
            } else {
                openTerminal();
                _setTermTabs('aichat');
            }
            return;
        }

        // Topbar Terminal — open interactive shell in split view
        if (t.closest('#btn-open-terminal')) { openShellTerminal('split'); return; }

        // Topbar Run — Python → execute in terminal; others → reload preview
        if (t.closest('#btn-run')) {
            const activeTab = document.querySelector('#tabs-container .tab.active');
            const af = activeTab?.dataset?.path || Store.state.activeFile;
            if (af && af.endsWith('.py')) {
                if (af !== Store.state.activeFile) UI.loadFile(af);
                // Manual run: if in a folder, cd to it first
                const parts = af.split('/');
                if (parts.length > 1) {
                    const project = parts[0];
                    const relPath = parts.slice(1).join('/');
                    const content = Store.state.files[af] || '';
                    if (content.includes('FastAPI') || content.includes('uvicorn')) {
                        // It's likely a FastAPI app
                        _runInShell(`uvicorn "${relPath.replace('.py', '').replace(/\//g, '.')}:app" --reload --port 8000`, project);
                    } else {
                        _runInShell(`python "${relPath}"`, project);
                    }
                } else {
                    const content = Store.state.files[af] || '';
                    if (content.includes('FastAPI') || content.includes('uvicorn')) {
                        _runInShell(`uvicorn "${af.replace('.py', '').replace(/\//g, '.')}:app" --reload --port 8000`);
                    } else {
                        _runInShell(`python "${af}"`);
                    }
                }
            } else {
                // Non-python files: if it's an HTML file and proxy is active, maybe switch back to static?
                // Or just reload.
                UI.reloadPreview();
            }
            return;
        }

        // Terminal buttons
        if (t.closest('#btn-close-terminal')) { closeTerminal(); return; }
        if (t.closest('#btn-clear-terminal')) { clearTerminal(); return; }
        if (t.closest('#btn-kill-port')) {
            const port = Store.state.previewPort || 8000;
            _termAppend(`\n[Stopping server on port ${port}…]\n`, 'info');
            // Send kill directly through the shell — more reliable than API on Linux
            const isWin = window._ideConfig?.platform === 'win32';
            const killCmd = isWin
                ? `for /f "tokens=5" %p in ('netstat -ano ^| findstr :${port}') do taskkill /F /PID %p`
                : `fuser -k ${port}/tcp 2>/dev/null && echo "[Server stopped]" || echo "[Nothing was running on :${port}]"`;
            _runInShell(killCmd);
            _setPortRunning(false);
            return;
        }

        // Toggle proxy preview
        if (t.closest('#btn-toggle-proxy')) {
            Store.state.previewMode = Store.state.previewMode === 'proxy' ? 'static' : 'proxy';
            Store.save();
            UI.updatePreview();
            return;
        }

        if (t.closest('#btn-pip-toggle')) {
            const grp = document.getElementById('pip-group');
            if (grp) {
                const showing = grp.style.display !== 'none';
                grp.style.display = showing ? 'none' : 'flex';
                if (!showing) document.getElementById('pip-input')?.focus();
            }
            return;
        }
        if (t.closest('#btn-pip-install')) {
            const inp = document.getElementById('pip-input');
            if (inp) { await pipInstall(inp.value); inp.value = ''; }
            return;
        }

        // Preview toolbar: Reload
        if (t.closest('#btn-refresh-preview')) { UI.reloadPreview(); return; }

        // Preview: Open in new tab
        if (t.closest('#btn-open-popup')) {
            const frame = document.getElementById('preview-frame');
            if (frame?.src && frame.src !== window.location.href) window.open(frame.src, '_blank');
            return;
        }

        // Mobile: Sidebar toggle
        if (t.closest('#btn-sidebar-toggle')) {
            document.body.classList.toggle('sidebar-open');
            return;
        }

        // Sidebar: Refresh
        if (t.closest('#btn-refresh-files')) {
            const btn = document.getElementById('btn-refresh-files');
            if (btn) btn.classList.add('spin');
            await Store.load();
            UI.init();
            if (btn) btn.classList.remove('spin');
            return;
        }

        // Sidebar: New File / Folder / Delete
        if (t.closest('#btn-new-file')) {
            const base = Store.state.activeFile.includes('/')
                ? Store.state.activeFile.substring(0, Store.state.activeFile.lastIndexOf('/') + 1)
                : '';
            const name = prompt('New file path:', base);
            if (name) {
                Store.updateFile(name, '');
                Store.state.openFiles.push(name);
                UI.renderFileTree();
                UI.loadFile(name);
            }
            return;
        }
        if (t.closest('#btn-new-folder')) {
            const name = prompt('New folder name:');
            if (name) { Store.updateFile(`${name}/.gitkeep`, ''); UI.renderFileTree(); }
            return;
        }
        if (t.closest('#btn-delete-item')) {
            const af = Store.state.activeFile;
            if (af && confirm(`Delete "${af}"?`)) Store.deleteFile(af);
            return;
        }

        // Chat: Clear
        if (t.closest('#btn-clear-chat')) {
            const msgs = document.getElementById('chat-messages');
            if (msgs) msgs.innerHTML = '';
            Store.state.chatHistory = [];
            Store.save();
            if (Store.state.activeProject) {
                fetch(`/api/projects/${encodeURIComponent(Store.state.activeProject)}/history`, {
                    method: 'DELETE'
                }).catch(() => { });
            }
            return;
        }

        // GitHub Publish
        if (t.closest('#btn-github-publish')) {
            openGitHubModal();
            return;
        }

        if (t.closest('#close-github-modal')) {
            document.getElementById('github-modal').style.display = 'none';
            return;
        }

        if (t.closest('#btn-do-publish')) {
            publishToGitHub();
            return;
        }
    });

    // ── Editor: debounced autosave + preview reload ───────────
    const editor = document.getElementById('code-editor');
    if (editor) {
        let timeout;
        editor.addEventListener('input', () => {
            UI.updateLineNumbers();
            clearTimeout(timeout);
            timeout = setTimeout(async () => {
                if (Store.state.activeFile) {
                    await Store.updateFile(Store.state.activeFile, editor.value);
                    if (!Store.state.activeFile.endsWith('.py')) UI.reloadPreview();
                }
            }, 800);
        });
    }

    // ── Autocomplete: editor keydown (navigate / accept) ─────
    const editorEl = document.getElementById('code-editor');
    if (editorEl) {
        editorEl.addEventListener('keydown', e => {
            if (AC.el?.style.display === 'block') {
                if (e.key === 'ArrowDown') { e.preventDefault(); AC.move(1); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); AC.move(-1); return; }
                if (e.key === 'Escape') { AC.hide(); return; }
                if (e.key === 'Tab' || e.key === 'Enter') {
                    if (AC.items.length && AC.selected >= 0) {
                        e.preventDefault();
                        AC.accept(editorEl);
                        UI.updateLineNumbers();
                        return;
                    }
                }
            }
        });
        editorEl.addEventListener('keyup', e => {
            const skip = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Shift', 'Control', 'Alt', 'Meta', 'Escape', 'Enter', 'Tab'];
            if (!skip.includes(e.key)) triggerComplete(editorEl);
            else if (['ArrowLeft', 'ArrowRight'].includes(e.key)) AC.hide();
        });
        editorEl.addEventListener('blur', () => setTimeout(() => AC.hide(), 160));
    }

    // Autocomplete item click
    document.getElementById('autocomplete-dropdown')?.addEventListener('mousedown', e => {
        e.preventDefault();
        const item = e.target.closest('.ac-item');
        if (item && editorEl) {
            AC.selected = parseInt(item.dataset.i);
            AC.accept(editorEl);
            UI.updateLineNumbers();
        }
    });

    // ── Terminal resizer drag ─────────────────────────────────
    (() => {
        const handle = document.getElementById('terminal-resizer');
        const target = document.getElementById('terminal-panel');
        if (!handle || !target) return;
        handle.addEventListener('mousedown', e => {
            e.preventDefault();
            const startY = e.clientY, startH = target.offsetHeight;
            const onMove = e => {
                target.style.height = Math.max(60, Math.min(
                    startH + (startY - e.clientY), window.innerHeight * 0.7
                )) + 'px';
            };
            const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    })();

    // ── Split-pane resizer (Shell ↔ AI Chat) ──────────────────
    (() => {
        const handle = document.getElementById('split-pane-resizer');
        const leftPane = document.getElementById('terminal-pane-shell');
        if (!handle || !leftPane) return;

        handle.addEventListener('mousedown', e => {
            e.preventDefault();
            handle.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';

            const startX = e.clientX;
            const startW = leftPane.offsetWidth;
            const bodyEl = leftPane.parentElement; // .terminal-body

            const onMove = e => {
                const delta = e.clientX - startX;
                const bodyW = bodyEl.offsetWidth;
                const newW = Math.max(160, Math.min(startW + delta, bodyW - 5 - 160));
                leftPane.style.flex = `0 0 ${newW}px`;
            };
            const onUp = () => {
                handle.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    })();

    // ── Terminal hidden input — captures all keystrokes ──────
    (() => {
        const hi = document.getElementById('terminal-hidden-input');
        const out = document.getElementById('terminal-output');
        if (!hi || !out) return;

        // Click on terminal shell pane → focus hidden input
        const pane = document.getElementById('terminal-pane-shell');
        pane?.addEventListener('click', () => {
            if (_termAlive) hi.focus();
        });

        hi.addEventListener('keydown', e => {
            if (!_termAlive) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                sendTermInput();
            } else if (e.key === 'Backspace') {
                e.preventDefault();
                _termInput = _termInput.slice(0, -1);
                _updateActiveLine();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (_termHistory.length > 0) {
                    _histIdx = Math.min(_histIdx + 1, _termHistory.length - 1);
                    _termInput = _termHistory[_histIdx] || '';
                    _updateActiveLine();
                }
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                _histIdx = Math.max(_histIdx - 1, -1);
                _termInput = _histIdx >= 0 ? (_termHistory[_histIdx] || '') : '';
                _updateActiveLine();
            } else if (e.key === 'l' && e.ctrlKey) {
                e.preventDefault();
                clearTerminal();
                if (_termAlive) _updateActiveLine();
            } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                _termInput += e.key;
                _updateActiveLine();
            }
        });

        hi.addEventListener('paste', e => {
            if (!_termAlive) return;
            e.preventDefault();
            const text = (e.clipboardData.getData('text') || '').split(/\r?\n/)[0];
            _termInput += text;
            _updateActiveLine();
        });
    })();

    // ── Terminal mode tabs ────────────────────────────────────
    document.querySelectorAll('.term-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const mode = tab.dataset.mode;
            if (mode === 'shell') {
                openShellTerminal('shell');
                if (_termAlive) setTimeout(() => document.getElementById('terminal-hidden-input')?.focus(), 80);
            } else if (mode === 'aichat') {
                openTerminal();
                _setTermTabs('aichat');
                _setTermRunning(false);
            } else if (mode === 'split') {
                // Split: shell on the left, AI chat on the right
                // Connect shell if needed, then activate split layout
                openShellTerminal('split');
                if (_termAlive) setTimeout(() => document.getElementById('terminal-hidden-input')?.focus(), 80);
            } else {
                // output mode — leave shell alive, just switch view
                _setTermTabs('output');
                _setTermRunning(false);
            }
        });
    });

    // ── pip input Enter ───────────────────────────────────────
    document.getElementById('pip-input')?.addEventListener('keydown', async e => {
        if (e.key === 'Enter') {
            await pipInstall(e.target.value);
            e.target.value = '';
            document.getElementById('pip-group').style.display = 'none';
        }
        if (e.key === 'Escape') document.getElementById('pip-group').style.display = 'none';
    });

    // ── Preview run-python message from iframe ────────────────
    window.addEventListener('message', e => {
        if (e.data === 'run-python' && Store.state.activeFile?.endsWith('.py')) {
            runPythonFile(Store.state.activeFile);
        }
    });

    // ── Chat: send ────────────────────────────────────────────
    document.getElementById('btn-send-chat')?.addEventListener('click', sendChat);
    document.getElementById('chat-input')?.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });

    // ── VFS nav from iframe ───────────────────────────────────
    window.addEventListener('message', e => {
        if (e.data?.type === 'preview-nav' && e.data.path?.endsWith('.html')) {
            Store.state.activeFile = e.data.path;
            UI.loadFile(e.data.path);
        }
    });

    // ============================================================
    // Chat Logic
    // ============================================================

    let _chatAbortCtrl = null;  // AbortController for cancelling in-flight requests
    let _chatContextFile = null;  // null = all, string = single file path
    let _chatContextFolder = null; // null = all, string = folder prefix
    let _ctxDropdownOpen = false;

    // ── File context picker helpers ────────────────────────────
    function _getFileIcon(ext) {
        const m = {
            html: '🌐', css: '🎨', js: '⚡', ts: '⚡', jsx: '⚡', tsx: '⚡',
            py: '🐍', json: '📋', md: '📝', txt: '📄', env: '🔑',
            sh: '🖥️', sql: '🗄️', png: '🖼️', jpg: '🖼️', svg: '🖼️'
        };
        return m[ext] || '📄';
    }

    function _updateCtxLabel() {
        const label = document.getElementById('chat-ctx-label');
        const trigger = document.getElementById('btn-file-ctx-trigger');
        if (!label) return;
        if (_chatContextFile) {
            label.textContent = _chatContextFile.split('/').pop();
            trigger?.classList.add('active');
        } else if (_chatContextFolder) {
            label.textContent = `${_chatContextFolder}/`;
            trigger?.classList.add('active');
        } else {
            label.textContent = 'All files';
            trigger?.classList.remove('active');
        }
    }

    function _setCtx(filePath, folder) {
        _chatContextFile = filePath || null;
        _chatContextFolder = folder || null;
        _updateCtxLabel();
        _closeCtxDropdown();
    }

    function _openCtxDropdown() {
        const dd = document.getElementById('file-ctx-dropdown');
        const trigger = document.getElementById('btn-file-ctx-trigger');
        const search = document.getElementById('ctx-search');
        if (!dd || !trigger) return;

        // Fixed positioning so the dropdown escapes overflow:hidden parents
        const rect = trigger.getBoundingClientRect();
        dd.style.bottom = `${window.innerHeight - rect.top + 6}px`;
        dd.style.left = `${rect.left}px`;

        dd.classList.add('open');
        _ctxDropdownOpen = true;
        if (search) search.value = '';
        _renderCtxList('');
        search?.focus();
    }

    function _closeCtxDropdown() {
        const dd = document.getElementById('file-ctx-dropdown');
        if (dd) dd.classList.remove('open');
        _ctxDropdownOpen = false;
    }

    function _renderCtxList(query) {
        const list = document.getElementById('ctx-list');
        if (!list) return;
        const allFiles = Store.state.files;
        const q = query.trim().toLowerCase();
        list.innerHTML = '';

        // ── If a folder is already selected, show only that folder's files ──
        if (_chatContextFolder) {
            // "Back to all" row
            if (!q) {
                const back = document.createElement('div');
                back.className = 'ctx-item ctx-back';
                back.innerHTML = `<span class="ctx-item-icon">↩</span><span class="ctx-item-name">All files</span>`;
                back.addEventListener('click', () => _setCtx(null, null));
                list.appendChild(back);

                // Folder header (active)
                const hdr = document.createElement('div');
                hdr.className = 'ctx-item ctx-folder active';
                const folderFiles = Object.keys(allFiles).filter(k => k.startsWith(_chatContextFolder + '/'));
                hdr.innerHTML = `<span class="ctx-item-icon">📁</span><span class="ctx-item-name">${_chatContextFolder}/</span><span class="ctx-item-count">${folderFiles.length}</span>`;
                hdr.addEventListener('click', () => _setCtx(null, _chatContextFolder)); // re-select same folder closes picker
                list.appendChild(hdr);
            }

            // Files in this folder only
            const prefix = _chatContextFolder + '/';
            let shown = 0;
            for (const path of Object.keys(allFiles).sort()) {
                if (!path.startsWith(prefix)) continue;
                const name = path.slice(prefix.length); // relative name within folder
                if (q && !name.toLowerCase().includes(q)) continue;
                if (++shown > 100) break;
                const ext = name.split('.').pop()?.toLowerCase() || '';
                const el = document.createElement('div');
                el.className = `ctx-item ctx-file${_chatContextFile === path ? ' active' : ''}`;
                el.innerHTML =
                    `<span class="ctx-item-icon">${_getFileIcon(ext)}</span>` +
                    `<span class="ctx-item-name">${name}</span>`;
                el.addEventListener('click', () => _setCtx(path, null));
                list.appendChild(el);
            }

            if (list.children.length === (q ? 0 : 2)) {
                list.innerHTML += '<div class="ctx-empty">No files in this folder yet</div>';
            }
            return;
        }

        // ── Default view: all files / folders ──
        if (!q) {
            const el = document.createElement('div');
            el.className = 'ctx-item active';
            el.innerHTML = `<span class="ctx-item-icon">🌐</span><span class="ctx-item-name">All files</span><span class="ctx-item-count">${Object.keys(allFiles).length}</span>`;
            el.addEventListener('click', () => _setCtx(null, null));
            list.appendChild(el);
        }

        // Folder rows
        const folders = {};
        for (const path of Object.keys(allFiles)) {
            const parts = path.split('/');
            if (parts.length > 1) folders[parts[0]] = (folders[parts[0]] || 0) + 1;
        }
        for (const [folder, count] of Object.entries(folders).sort()) {
            if (q && !folder.toLowerCase().includes(q)) continue;
            const el = document.createElement('div');
            el.className = 'ctx-item ctx-folder';
            el.innerHTML = `<span class="ctx-item-icon">📁</span><span class="ctx-item-name">${folder}/</span><span class="ctx-item-count">${count}</span>`;
            el.addEventListener('click', () => _setCtx(null, folder));
            list.appendChild(el);
        }

        // Root-level files (no folder)
        let shown = 0;
        for (const path of Object.keys(allFiles).sort()) {
            if (path.includes('/')) continue; // skip files inside folders
            if (q && !path.toLowerCase().includes(q)) continue;
            if (++shown > 50) break;
            const ext = path.split('.').pop()?.toLowerCase() || '';
            const el = document.createElement('div');
            el.className = `ctx-item ctx-file${_chatContextFile === path ? ' active' : ''}`;
            el.innerHTML =
                `<span class="ctx-item-icon">${_getFileIcon(ext)}</span>` +
                `<span class="ctx-item-name">${path}</span>`;
            el.addEventListener('click', () => _setCtx(path, null));
            list.appendChild(el);
        }

        if (!list.children.length) {
            list.innerHTML = '<div class="ctx-empty">No files yet</div>';
        }
    }

    // Trigger button
    document.getElementById('btn-file-ctx-trigger')?.addEventListener('click', e => {
        e.stopPropagation();
        _ctxDropdownOpen ? _closeCtxDropdown() : _openCtxDropdown();
    });

    // Close when clicking outside
    document.addEventListener('click', e => {
        if (_ctxDropdownOpen && !document.getElementById('file-ctx-picker')?.contains(e.target)) {
            _closeCtxDropdown();
        }
    });

    // Live search inside dropdown
    document.getElementById('ctx-search')?.addEventListener('input', e => {
        _renderCtxList(e.target.value);
    });
    document.getElementById('ctx-search')?.addEventListener('keydown', e => {
        if (e.key === 'Escape') _closeCtxDropdown();
    });

    // Auto-sync context when user clicks a file in the sidebar
    // (only updates if no manual context has been set)
    const _origLoadFile = UI.loadFile.bind(UI);
    UI.loadFile = function (path, ...args) {
        _origLoadFile(path, ...args);
        // If context is "All files", auto-follow the active file's folder
        if (!_chatContextFile && !_chatContextFolder) {
            // Don't change — let user stay on "All files"
        }
        // If they had a file ctx set, update it to newly opened file
        else if (_chatContextFile && _chatContextFile !== path) {
            // Don't auto-change; user manually picked a file — keep it
        }
    };

    // ── Stop button ────────────────────────────────────────────
    document.getElementById('btn-stop-chat')?.addEventListener('click', () => {
        if (_chatAbortCtrl) {
            _chatAbortCtrl.abort();
        }
    });

    // Esc key stops generation
    document.getElementById('chat-input')?.addEventListener('keydown', e => {
        if (e.key === 'Escape' && _chatAbortCtrl) {
            _chatAbortCtrl.abort();
        }
    });

    async function sendChat() {
        const input = document.getElementById('chat-input');
        if (!input) return;
        const msg = input.value.trim();
        if (!msg) return;

        addMsg(msg, 'user');
        input.value = '';
        input.style.height = '';

        // ── New Project OR build request in active project ────────────────────
        const isBuild = isProjectRequest(msg);
        const isCreation = isCreationRequest(msg);

        // HARD BLOCK: Never switch projects if it's clearly a command (run, start, stop, install)
        const isCommand = /^\s*(run|start|stop|kill|restart|install|pip|npm|python|uvicorn|node|docker|test|debug)\b/i.test(msg);

        const needsProject = !isCommand && (
            Store.state.activeProject === '__new__' ||
            !Store.state.activeProject
        );

        if (needsProject) {
            let name = extractProjectName(msg);
            // If extraction results in a generic/verb name, fallback to active project if possible
            if (['run', 'test', 'debug', 'build', 'start'].includes(name) && Store.state.activeProject && Store.state.activeProject !== '__new__') {
                name = Store.state.activeProject;
            }
            Store.state.activeProject = name;
            Store.save();

            // Add to dropdown and select it
            const sel = document.getElementById('project-select');
            if (sel && !sel.querySelector(`option[value="${name}"]`)) {
                const opt = new Option(name, name);
                sel.insertBefore(opt, sel.querySelector('option[value="__new__"]'));
            }
            if (sel) sel.value = name;

            // Auto-scope chat context to this new project folder
            _setCtx(null, name);

            addMsg(`📁 Project folder: **${name}**`, 'ai');
        }

        Store.state.chatHistory.push({
            role: 'user', content: msg,
            ctx_file: _chatContextFile || undefined,
            ctx_folder: _chatContextFolder || undefined
        });

        _chatAbortCtrl = new AbortController();
        setBusy(true);
        try {
            if (isProjectRequest(msg) || _agentModeEnabled) {
                await runAgentPipeline(msg);
            } else {
                const data = await apiChat(msg, Store.state.files, _chatAbortCtrl.signal);
                if (data.message) addMsg(data.message, 'ai');
                if (!data.actions?.length) {
                    addMsg('⚠️ No files were changed. Try rephrasing your request.', 'ai');
                } else {
                    await applyActions(data.actions);
                }
                if (data.setup_instructions) showSetupInstructions(data.setup_instructions);
                Store.state.chatHistory.push({
                    role: 'assistant', content: data.message || 'Done',
                    ctx_file: _chatContextFile || undefined,
                    ctx_folder: _chatContextFolder || undefined
                });
                await saveConversation();
            }
        } catch (e) {
            if (e.name === 'AbortError') {
                addMsg('⏹️ **Stopped.** Generation cancelled.', 'ai');
            } else {
                addMsg(`❌ ${e.message}`, 'ai');
            }
        } finally {
            _chatAbortCtrl = null;
            setBusy(false);
        }
    }

    // ── Derive a clean slug folder name from user message ────────
    function extractProjectName(msg) {
        const lo = msg.toLowerCase();

        // 1. Known domain keywords — find the most specific one in the message
        const DOMAINS = [
            'calculator', 'todo', 'notes', 'chat', 'weather', 'blog', 'shop', 'store',
            'portfolio', 'dashboard', 'quiz', 'game', 'music', 'gallery', 'booking',
            'inventory', 'crm', 'cms', 'analytics', 'finance', 'expense', 'task',
            'calendar', 'recipe', 'food', 'travel', 'hotel', 'restaurant', 'fitness',
            'gym', 'health', 'social', 'forum', 'news', 'email', 'file', 'image',
            'video', 'map', 'crypto', 'stock', 'banking', 'invoice', 'survey',
            'poll', 'voting', 'auction', 'rental', 'delivery', 'tracking', 'review',
            'rating', 'comment', 'ticket', 'support', 'helpdesk', 'kanban', 'board',
            'editor', 'markdown', 'wiki', 'docs', 'resume', 'cv', 'link', 'url',
            'shortener', 'qr', 'barcode', 'chat', 'messenger', 'notification', 'alert'
        ];
        for (const kw of DOMAINS) {
            if (lo.includes(kw)) return kw;
        }

        // 0. Hard exit for commands at start of msg
        if (/^\s*(run|start|stop|kill|restart|install|pip|npm|python|uvicorn|debug|fix|test)\b/i.test(msg)) {
            return Store.state.activeProject && Store.state.activeProject !== '__new__' ? Store.state.activeProject : 'new-project';
        }

        // 1.5 Stop words/verbs that should NOT be project names
        const STOP_VERBS = new Set(['run', 'start', 'stop', 'kill', 'restart', 'install', 'build', 'create', 'make', 'develop', 'design', 'debug', 'fix', 'test', 'help', 'app', 'tool', 'system', 'site', 'project']);

        // 2. Pattern: "create/build a(n) [WORD] app/application/system/tool/platform"
        const createMatch = lo.match(
            /(?:create|build|make|develop|design)\s+(?:a\s+|an\s+)?(?:complete\s+|simple\s+|full[- ]stack\s+)?([a-z][a-z0-9]+)\s+(?:web\s+)?(?:app|application|system|tool|platform|service|website|site)/
        );
        if (createMatch) {
            const w = createMatch[1];
            const generic = new Set(['the', 'this', 'that', 'web', 'full', 'complete', 'simple', 'modern', 'basic', 'new', 'my', 'your', 'our']);
            if (w.length > 2 && !generic.has(w)) return w;
        }

        // 3. Strip role-play / persona prefixes then use remaining words
        let s = lo
            .replace(/[^a-z0-9 ]/g, ' ')
            // "you are a senior X developer. ..."  or  "act as a X developer"
            .replace(/^(?:you\s+are\s+(?:a\s+)?(?:senior\s+|junior\s+|expert\s+)?(?:[a-z]+\s+){0,4}developer\.?\s*)/i, '')
            .replace(/^(?:act\s+as\s+(?:a\s+)?(?:[a-z]+\s+){0,3})/i, '')
            // leading command verbs
            .replace(/^(?:create|build|make|develop|design)\s+(?:me\s+)?(?:a\s+|an\s+)?/, '');

        // Strip generic type words
        s = s.replace(/\b(?:website|webpage|web app|web site|app|application|page|project|platform|system|tool|site|software|complete|using|with|backend|frontend|database)\b/g, ' ');
        s = s.replace(/\bfor\s+(?:selling|buying|managing|ordering|listing|tracking)\s+/g, ' ');
        s = s.replace(/\bfor\s+/g, ' ');

        const stop = new Set([
            'a', 'an', 'the', 'my', 'our', 'new', 'modern', 'responsive', 'advanced',
            'full', 'complete', 'and', 'or', 'with', 'using', 'is', 'that', 'this',
            'can', 'will', 'where', 'which', 'items', 'things', 'products', 'users',
            'you', 'are', 'senior', 'junior', 'expert', 'developer', 'engineer',
            ...STOP_VERBS
        ]);

        const words = s.split(/\s+/).filter(w => w.length > 1 && !stop.has(w));

        return (words.slice(0, 2).join('-') || 'new-project')
            .replace(/[^a-z0-9-]/g, '')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
    }

    // ── Detect project-scale requests ─────────────────────────
    function isProjectRequest(msg) {
        const lo = msg.toLowerCase();
        const term = ['run', 'stop', 'kill', 'restart', 'install', 'pip ', 'npm ', 'python ', 'uvicorn', 'debug', 'fix', 'test'];
        return isCreationRequest(msg) || term.some(k => lo.includes(k)) || msg.length > 250;
    }

    // ── Detect explicit creation intent ────────────────────────
    function isCreationRequest(msg) {
        const lo = msg.toLowerCase();
        const web = ['website', 'web app', 'ecommerce', 'e-commerce', 'portfolio', 'dashboard',
            'landing page', 'full page', 'blog', 'shop', 'restaurant', 'agency', 'saas',
            'build me', 'create a full', 'complete website', 'fully responsive', 'multi-page',
            'resume', 'resume maker', 'builder', 'calculator', 'todo app', 'quiz', 'game',
            'chat app', 'weather app', 'music player'];
        const py = ['python', 'flask', 'fastapi', 'django', 'pandas', 'numpy', 'matplotlib',
            'machine learning', 'sklearn', 'scraper', 'automation', 'cli tool', '.py file',
            'data analysis', 'bot', 'tkinter', 'pygame', 'rest api server'];
        const fs = ['full stack', 'full-stack', 'fullstack', 'complete app', 'end-to-end', 'rest api', 'api server'];
        const createVerbs = ['create a', 'build a', 'make a', 'generate a', 'setup a', 'develop a', 'design a', 'new project'];

        return web.some(k => lo.includes(k)) || py.some(k => lo.includes(k)) ||
            fs.some(k => lo.includes(k)) || createVerbs.some(k => lo.startsWith(k) || lo.includes(' ' + k + ' '));
    }

    // ── Detect full-stack (backend + frontend) requests ───────
    function isFullStackRequest(msg) {
        const lo = msg.toLowerCase();
        // Backend signals
        const hasBackend = /\b(fastapi|flask|django|express|backend|rest\s*api|crud|database|sqlite|mysql|postgres|mongodb|auth(entication)?|login|register|signup|user\s+account|jwt|endpoint|api\s+server|with\s+api|with\s+database|with\s+db)\b/i.test(lo);
        // Explicit full-stack signals
        const explicitFS = /\b(full.?stack|complete\s+app|complete\s+web\s+app|production\s+app|end.?to.?end|with\s+backend|with\s+frontend)\b/i.test(lo);
        return explicitFS || (hasBackend && msg.length > 60);
    }

    // ── Ensure a project folder is active before building ─────
    function requireProject() {
        const p = Store.state.activeProject;
        // '__new__' is handled in sendChat before buildProject is called
        if (p && p !== '__new__') return p;
        return null;
    }

    // ── Force all actions into the target folder ───────────────
    // Legitimate subfolder names that must be preserved as-is
    const _KNOWN_SUBFOLDERS = new Set([
        'frontend', 'backend', 'src', 'lib', 'static', 'assets', 'public',
        'api', 'templates', 'pages', 'components', 'styles', 'scripts',
        'tests', 'test', 'docs', 'config', 'utils', 'helpers', 'models',
        'routes', 'controllers', 'services', 'middleware', 'database', 'db'
    ]);

    function lockToFolder(actions, folder) {
        return actions.map(a => {
            if (!a.file) return a;
            if (a.file.startsWith(folder + '/')) return a; // already correct

            if (a.file.includes('/')) {
                const firstPart = a.file.split('/')[0];
                const restOfPath = a.file.split('/').slice(1).join('/');

                if (_KNOWN_SUBFOLDERS.has(firstPart)) {
                    // AI forgot the top-level folder but used a valid subfolder
                    // e.g. "frontend/index.html" → "myapp/frontend/index.html"
                    return { ...a, file: `${folder}/${a.file}` };
                } else {
                    // AI hallucinated a different project name as prefix
                    // e.g. "calculator-app/backend/main.py" → "myapp/backend/main.py"
                    return { ...a, file: `${folder}/${restOfPath}` };
                }
            }

            // No slash — just a bare filename, prefix the folder
            return { ...a, file: `${folder}/${a.file}` };
        });
    }

    // ── Phased project builder ────────────────────────────────
    async function buildProject(originalMsg) {
        let folder;

        const current = Store.state.activeProject;

        if (current && current !== '__new__') {
            // User explicitly selected a project from the dropdown — use it as-is
            folder = current;
        } else {
            // No project selected (or __new__ still pending) — derive folder from message
            folder = extractProjectName(originalMsg);
            Store.state.activeProject = folder;
            Store.save();
            const sel = document.getElementById('project-select');
            if (sel && !sel.querySelector(`option[value="${folder}"]`)) {
                const opt = new Option(folder, folder);
                sel.insertBefore(opt, sel.querySelector('option[value="__new__"]'));
            }
            if (sel) sel.value = folder;
        }

        const brief = originalMsg.length > 500
            ? originalMsg.substring(0, 500) + '...'
            : originalMsg;

        const getFiles = () => Object.fromEntries(
            Object.entries(Store.state.files).filter(([k]) => k.startsWith(folder + '/'))
        );

        // Absolute folder lock rule — prepended to every phase
        const LOCK = `⚠️ FOLDER LOCK: Every single file path MUST start with "${folder}/" (e.g. "${folder}/index.html", "${folder}/style.css", "${folder}/script.js"). Do NOT create files in any other folder.`;

        addMsg(`🏗️ **Building \`${folder}/\`** — 3 phases.`, 'ai');

        // ── Phase 1: HTML ──────────────────────────────────────
        addMsg('📄 **Phase 1/3** — HTML structure…', 'ai');
        const p1 = await apiChat(
            `${LOCK}

PROJECT BRIEF: ${brief}

PHASE 1/3 — BUILD ONE COMPLETE HTML FILE: "${folder}/index.html"

MANDATORY <head>:
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Poppins:wght@600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="style.css">

MANDATORY SECTIONS in <body> (in this order):
1. <nav id="navbar"> — logo text on left + ul.nav-links on right + .btn-cta "Get Started" + <button class="hamburger">☰</button>
2. <section class="hero"> — <h1> with <span class="gradient-text"> for key words, <p class="hero-sub">, two buttons (.btn-primary + .btn-secondary), <div class="hero-glow">
3. <section class="features" id="features"> — <h2> heading + <div class="features-grid"> with 6 <div class="feature-card"> each having an emoji icon, <h3>, and <p> with REAL specific content
4. <section class="about" id="about"> — two-column layout: real description + <div class="stats-grid"> with 4 real stats (numbers that make sense for this project)
5. A domain-specific section tailored to: ${brief} — e.g. pricing, menu, gallery, testimonials, equipment list
6. <section class="contact" id="contact"> — <form id="contact-form"> with name/email/message inputs + submit button
7. <footer> — logo + <ul class="footer-links"> + copyright

CONTENT RULES:
- Write REAL specific content for this exact project: ${brief}
- ZERO lorem ipsum — every word must be relevant to the project
- Feature cards must describe REAL features of this specific product
- Stats must be realistic numbers (e.g. "500+ Members", "10+ Trainers")
- Hero headline must be compelling and specific to the project

<script src="script.js"></script> before </body>
Return ONE add_file action for "${folder}/index.html"`,
            getFiles()
        );
        if (!p1.actions?.length) { addMsg('❌ Phase 1 produced no files.', 'ai'); return; }
        const fixed1 = lockToFolder(p1.actions, folder);
        await applyActions(fixed1, false);

        const htmlFiles = fixed1.filter(a => a.file?.endsWith('.html')).map(a => a.file);
        const pageNames = htmlFiles.map(f => f.split('/').pop());
        addMsg(`✅ HTML: ${pageNames.join(', ')}`, 'ai');

        // ── Phase 2: CSS ───────────────────────────────────────
        addMsg('🎨 **Phase 2/3** — Premium CSS…', 'ai');
        const p2 = await apiChat(
            `${LOCK}

PROJECT BRIEF: ${brief}

PHASE 2/3 — BUILD ONE PREMIUM CSS FILE: "${folder}/style.css"

Choose a COLOR THEME that fits the project (e.g. gym=orange/red, food=green/orange, tech=blue/purple, finance=blue/gold).

REQUIRED :root variables:
  --primary: [choose]; --primary-dark: [darker]; --primary-rgb: [r,g,b for rgba()];
  --accent: [complementary color]; --accent-rgb: [r,g,b];
  --bg: #070710; --surface: #0e0e1c; --surface2: #16162a;
  --border: rgba(255,255,255,0.07); --border2: rgba(255,255,255,0.13);
  --text: #f0f0ff; --muted: #9090b0; --radius: 16px; --radius-lg: 24px;
  --transition: all 0.3s cubic-bezier(0.4,0,0.2,1);

REQUIRED STYLES (write ALL of these, in full):

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); overflow-x: hidden; }

nav#navbar:
  position:sticky; top:0; z-index:1000; padding:0 5%;
  display:flex; align-items:center; justify-content:space-between; height:70px;
  background:rgba(7,7,16,0.85); backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px);
  border-bottom:1px solid var(--border);
  transition: var(--transition);
  .scrolled class: box-shadow:0 4px 30px rgba(0,0,0,0.3); height:60px;

.hero:
  min-height:100vh; display:flex; align-items:center; justify-content:center; text-align:center;
  background: radial-gradient(ellipse 80% 60% at 50% -10%, rgba(var(--primary-rgb),0.35) 0%, transparent 60%),
              radial-gradient(ellipse 60% 40% at 80% 80%, rgba(var(--accent-rgb),0.15) 0%, transparent 50%),
              var(--bg);
  padding: 120px 5% 80px;
  h1: font-family:'Poppins'; font-size:clamp(2.8rem,6vw,5.5rem); font-weight:800; line-height:1.1; margin-bottom:24px;
  .gradient-text: background:linear-gradient(135deg,var(--primary),var(--accent)); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text;
  .hero-sub: font-size:clamp(1rem,2vw,1.3rem); color:var(--muted); max-width:600px; margin:0 auto 40px; line-height:1.7;
  .hero-glow: position:absolute; width:600px; height:600px; border-radius:50%; background:rgba(var(--primary-rgb),0.1); filter:blur(80px); top:50%; left:50%; transform:translate(-50%,-50%); pointer-events:none; z-index:-1;

.btn-primary:
  display:inline-flex; align-items:center; gap:8px; padding:14px 36px; border-radius:50px;
  background:linear-gradient(135deg,var(--primary),var(--primary-dark)); color:#fff;
  font-weight:600; font-size:1rem; border:none; cursor:pointer; text-decoration:none;
  transition:var(--transition); box-shadow:0 4px 20px rgba(var(--primary-rgb),0.3);
  hover: transform:translateY(-3px); box-shadow:0 8px 35px rgba(var(--primary-rgb),0.5);

.btn-secondary:
  display:inline-flex; padding:14px 36px; border-radius:50px;
  background:rgba(255,255,255,0.06); color:var(--text); border:1px solid var(--border2);
  font-weight:600; cursor:pointer; text-decoration:none; transition:var(--transition);
  hover: background:rgba(255,255,255,0.1); transform:translateY(-2px);

.features-grid: display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:24px;
.feature-card:
  background:rgba(255,255,255,0.03); border:1px solid var(--border);
  backdrop-filter:blur(12px); border-radius:var(--radius); padding:36px 32px;
  transition:var(--transition); cursor:default;
  .card-icon: font-size:2.5rem; margin-bottom:20px; display:block;
  h3: font-size:1.2rem; font-weight:700; margin-bottom:12px; font-family:'Poppins';
  p: color:var(--muted); line-height:1.7;
  hover: transform:translateY(-10px); border-color:var(--primary); box-shadow:0 24px 60px rgba(var(--primary-rgb),0.2);

Section headings (.section-title):
  font-family:'Poppins'; font-size:clamp(1.8rem,4vw,3rem); font-weight:800; margin-bottom:16px;
  background:linear-gradient(135deg,var(--text),var(--muted)); -webkit-background-clip:text; -webkit-text-fill-color:transparent;

.stats-grid: display:grid; grid-template-columns:repeat(2,1fr); gap:20px;
.stat-card: background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:28px; text-align:center;
  .stat-number: font-size:2.5rem; font-weight:800; font-family:'Poppins'; color:var(--primary);
  .stat-label: color:var(--muted); font-size:0.9rem; margin-top:4px;

Contact form: inputs/textarea with background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:14px 18px; color:var(--text); width:100%; transition:var(--transition);
  focus: border-color:var(--primary); box-shadow:0 0 0 3px rgba(var(--primary-rgb),0.15); outline:none;

ANIMATIONS:
@keyframes fadeInUp { from{opacity:0;transform:translateY(40px)} to{opacity:1;transform:translateY(0)} }
@keyframes float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-15px)} }
@keyframes pulse-glow { 0%,100%{box-shadow:0 0 20px rgba(var(--primary-rgb),0.3)} 50%{box-shadow:0 0 50px rgba(var(--primary-rgb),0.6)} }
.fade-in-up { opacity:0; transform:translateY(40px); transition:opacity 0.6s ease,transform 0.6s ease; }
.fade-in-up.visible { opacity:1; transform:translateY(0); }

Footer: background:var(--surface); border-top:1px solid var(--border); padding:60px 5% 30px;

RESPONSIVE (768px breakpoint): stack all grids to 1 column, hide .nav-links, show .hamburger, reduce font sizes
RESPONSIVE (480px): reduce padding, smaller buttons

Minimum 700 lines. Style EVERY element in the HTML.
Return ONE add_file action for "${folder}/style.css"`,
            getFiles()
        );
        if (p2.actions?.length) {
            await applyActions(lockToFolder(p2.actions, folder), false);
            addMsg('✅ CSS done.', 'ai');
        } else {
            addMsg('⚠️ Phase 2 produced no CSS.', 'ai');
        }

        // ── Phase 3: JavaScript ────────────────────────────────
        addMsg('⚡ **Phase 3/3** — JavaScript…', 'ai');
        const p3 = await apiChat(
            `${LOCK}

PROJECT BRIEF: ${brief}

PHASE 3/3 — BUILD ONE JS FILE: "${folder}/script.js"

REQUIRED FEATURES (implement ALL, no stubs, no TODOs):

1. Mobile nav: hamburger click toggles .nav-open on body; clicking nav links closes menu
2. Navbar scroll: add .scrolled class to #navbar when scrollY > 50
3. Smooth scroll: all <a href="#..."> links smoothly scroll to target section
4. Scroll animations: IntersectionObserver on all .fade-in-up elements → add .visible class
5. Active nav highlight: update .active class on nav links as user scrolls past sections
6. Contact form: validate all fields (required, email format), show inline .error-msg on invalid, show .toast success message on valid submit, reset form
7. Domain-specific features for: ${brief}
   Examples: product filter/search, image gallery lightbox, counter animation for stats, accordion FAQ, tab switching, cart functionality, pricing toggle, etc.

Return ONE add_file action for "${folder}/script.js"`,
            getFiles()
        );
        if (p3.actions?.length) {
            await applyActions(lockToFolder(p3.actions, folder), false);
            addMsg('✅ JavaScript done.', 'ai');
        } else {
            addMsg('⚠️ Phase 3 produced no JS.', 'ai');
        }

        // ── Final sync ────────────────────────────────────────
        Store.save();
        UI.renderFileTree();
        UI.renderTabs();
        const indexFile = `${folder}/index.html`;
        const firstHtml = htmlFiles[0];
        const toOpen = Store.state.files[indexFile] ? indexFile : firstHtml;
        if (toOpen) {
            if (!Store.state.openFiles.includes(toOpen)) Store.state.openFiles.push(toOpen);
            UI.loadFile(toOpen);
        }
        setTimeout(() => UI.reloadPreview(), 400);
        addMsg('🎉 **Project complete!** Check the preview.', 'ai');
        Store.state.chatHistory.push({ role: 'assistant', content: `Built "${folder}": ${brief.substring(0, 60)}` });
        Store.save();
        await saveConversation();
        await loadProjects(); // refresh dropdown so new project appears
    }

    // ── Python project detection ──────────────────────────────
    function isPythonRequest(msg) {
        const lo = msg.toLowerCase();
        return ['python', 'flask', 'fastapi', 'django', 'pandas', 'numpy', 'matplotlib',
            'machine learning', 'sklearn', 'tensorflow', 'pytorch', 'scraper', 'web scraper',
            'automation', 'cli tool', 'command line', 'pip install', '.py file',
            'data analysis', 'csv', 'rest api server', 'bot', 'tkinter', 'pygame'
        ].some(k => lo.includes(k));
    }

    // ── Python project builder (single-phase) ─────────────────
    async function buildPythonProject(originalMsg) {
        let folder;
        const current = Store.state.activeProject;
        if (current && current !== '__new__') {
            folder = current;
        } else {
            folder = extractProjectName(originalMsg);
            Store.state.activeProject = folder;
            Store.save();
            const sel = document.getElementById('project-select');
            if (sel && !sel.querySelector(`option[value="${folder}"]`)) {
                sel.insertBefore(new Option(folder, folder), sel.querySelector('option[value="__new__"]'));
            }
            if (sel) sel.value = folder;
        }

        const brief = originalMsg.length > 500 ? originalMsg.substring(0, 500) + '...' : originalMsg;
        const LOCK = `⚠️ FOLDER LOCK: Every file MUST start with "${folder}/" (e.g. "${folder}/main.py", "${folder}/requirements.txt").`;

        addMsg(`🐍 **Building Python project \`${folder}/\`**…`, 'ai');

        const result = await apiChat(
            `${LOCK}

PROJECT BRIEF: ${brief}

BUILD A COMPLETE PYTHON PROJECT. Required files:

1. "${folder}/main.py" — Full, immediately runnable Python code.
   - Must work with: python main.py
   - if __name__ == '__main__': guard required
   - Use print() to show meaningful output
   - No stubs, no TODOs — every function fully implemented
   - Real logic, realistic sample data

2. "${folder}/requirements.txt" — ONLY if external packages needed (one per line).
   Skip this file if only Python stdlib is used.

3. Extra .py modules only if the architecture genuinely needs them.

Return file actions for all files under "${folder}/"`,
            Object.fromEntries(Object.entries(Store.state.files).filter(([k]) => k.startsWith(folder + '/')))
        );

        if (!result.actions?.length) { addMsg('❌ No files generated.', 'ai'); return; }
        const fixed = lockToFolder(result.actions, folder);
        await applyActions(fixed, true);

        const names = fixed.map(a => a.file?.split('/').pop()).filter(Boolean).join(', ');
        addMsg(`✅ **Done!** Generated: \`${names}\``, 'ai');
        addMsg(`▶ Click **Run** to execute \`${folder}/main.py\``, 'ai');

        Store.state.chatHistory.push({ role: 'assistant', content: `Built Python project "${folder}": ${brief.substring(0, 60)}` });
        Store.save();
        await saveConversation();
        await loadProjects();
    }

    // ── Full-Stack Project Builder (FastAPI + HTML/CSS/JS) ────
    async function buildFullStackProject(originalMsg) {
        let folder;
        const current = Store.state.activeProject;
        if (current && current !== '__new__') {
            folder = current;
        } else {
            folder = extractProjectName(originalMsg);
            Store.state.activeProject = folder;
            Store.save();
            const sel = document.getElementById('project-select');
            if (sel && !sel.querySelector(`option[value="${folder}"]`)) {
                sel.insertBefore(new Option(folder, folder), sel.querySelector('option[value="__new__"]'));
            }
            if (sel) sel.value = folder;
        }

        const brief = originalMsg.length > 600 ? originalMsg.substring(0, 600) + '...' : originalMsg;
        const LOCK = `⚠️ FOLDER LOCK: Every file path MUST start with "${folder}/" (e.g. "${folder}/backend/main.py", "${folder}/frontend/index.html"). No files outside "${folder}/".`;

        const getFiles = () => Object.fromEntries(
            Object.entries(Store.state.files).filter(([k]) => k.startsWith(folder + '/'))
        );

        addMsg(`🏗️ **Building full-stack app \`${folder}/\`**`, 'ai');
        addMsg('📋 **Planning architecture…** Backend (FastAPI) + Frontend (HTML/CSS/JS)', 'ai', 'phase');

        // ── Phase 1: Backend ───────────────────────────────────
        addMsg('🔧 **Phase 1/3** — FastAPI backend + database models…', 'ai', 'phase');
        const p1 = await apiChat(
            `${LOCK}

PROJECT BRIEF: ${brief}

PHASE 1/3 — BUILD THE COMPLETE BACKEND.

Required files (all inside "${folder}/backend/"):

1. "${folder}/backend/main.py"
   - FastAPI app with ALL routes defined BEFORE the static mount
   - CORS middleware (allow_origins=["*"])
   - All CRUD endpoints that this app needs
   - Mount frontend: app.mount("/", StaticFiles(directory=str(Path(__file__).parent.parent / "frontend"), html=True), name="frontend")
   - if __name__ == "__main__": uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
   - Startup print("🚀 Server running at http://localhost:8000")

2. "${folder}/backend/models.py" — Pydantic request/response models for all entities

3. "${folder}/backend/database.py" — SQLAlchemy setup (SQLite) only if data persistence is needed:
   engine + SessionLocal + Base + all ORM models + create_all on startup

4. "${folder}/requirements.txt" — ALL needed packages:
   fastapi, uvicorn[standard], sqlalchemy, python-dotenv
   (add others: passlib[bcrypt]+python-jose[cryptography] for auth, aiofiles for uploads)

5. "${folder}/.env.example" — All environment variables with example values

All endpoints must be fully implemented with real logic.
Frontend API calls will use fetch('/api/...') — relative URLs.`,
            getFiles(),
            _chatAbortCtrl?.signal
        );
        if (_chatAbortCtrl?.signal?.aborted) return;
        if (!p1.actions?.length) { addMsg('❌ Phase 1 failed — no backend files.', 'ai'); return; }
        await applyActions(lockToFolder(p1.actions, folder), false);
        addMsg('✅ Backend API created.', 'ai');

        // ── Phase 2: Frontend ──────────────────────────────────
        addMsg('🎨 **Phase 2/3** — HTML/CSS/JS frontend…', 'ai', 'phase');
        const p2 = await apiChat(
            `${LOCK}

PROJECT BRIEF: ${brief}

PHASE 2/3 — BUILD THE COMPLETE FRONTEND (inside "${folder}/frontend/").

Required files:
1. "${folder}/frontend/index.html" — Main HTML with all UI sections
2. "${folder}/frontend/style.css"  — Modern dark-themed responsive styles
3. "${folder}/frontend/script.js"  — All frontend JS, API calls use fetch('/api/...') RELATIVE paths

FRONTEND RULES:
- API calls: fetch('/api/route') — NO hardcoded http://localhost:8000
- Dark theme: #070710 bg, glassmorphism cards, gradient buttons
- Responsive: mobile-first, 480px/768px/1024px breakpoints
- Show loading states while fetching data
- Handle API errors gracefully with user-facing messages
- Real, functional UI for: ${brief}
- Navigation header + main content area + footer
- All buttons and forms must wire up to the API endpoints from Phase 1`,
            getFiles(),
            _chatAbortCtrl?.signal
        );
        if (_chatAbortCtrl?.signal?.aborted) return;
        if (!p2.actions?.length) { addMsg('⚠️ Phase 2 produced no frontend files.', 'ai'); }
        else {
            await applyActions(lockToFolder(p2.actions, folder), false);
            addMsg('✅ Frontend UI created.', 'ai');
        }

        // ── Phase 3: Refresh UI and show instructions ──────────
        Store.save();
        UI.renderFileTree();
        UI.renderTabs();
        setTimeout(() => UI.reloadPreview(), 300);

        addMsg('⚡ **Phase 3/3** — Generating setup instructions…', 'ai', 'phase');
        const instructions = {
            install: ['pip install -r requirements.txt'],
            run: [`cd ${folder}`, 'python backend/main.py'],
            env_template: 'SECRET_KEY=your-secret-key-here\nDB_URL=sqlite:///app.db\nPORT=8000',
            visit: 'http://localhost:8000',
            notes: 'The frontend is served automatically. Copy .env.example to .env and fill in values before starting.'
        };
        // Use setup_instructions from AI if provided
        if (p1.setup_instructions) Object.assign(instructions, p1.setup_instructions);

        addMsg(`✅ **\`${folder}/\` built!** ${Object.keys(Store.state.files).filter(k => k.startsWith(folder + '/')).length} files created.`, 'ai');
        showSetupInstructions(instructions, folder);

        Store.state.chatHistory.push({ role: 'assistant', content: `Built full-stack app "${folder}": ${brief.substring(0, 80)}` });
        Store.save();
        await saveConversation();
        await loadProjects();
    }

    // ── Show post-build setup instructions ────────────────────
    function showSetupInstructions(si, folder) {
        if (!si) return;
        let md = '---\n## 🚀 How to Run Your Project\n\n';
        if (si.install?.length) {
            md += `**1. Install dependencies:**\n\`\`\`bash\n${si.install.join('\n')}\n\`\`\`\n\n`;
        }
        if (si.env_template) {
            const envFile = folder ? `${folder}/.env` : '.env';
            md += `**2. Create \`.env\` file** (copy from \`.env.example\`):\n\`\`\`env\n${si.env_template}\n\`\`\`\n\n`;
        }
        if (si.run?.length) {
            md += `**3. Start the app:**\n\`\`\`bash\n${si.run.join('\n')}\n\`\`\`\n\n`;
        }
        if (si.visit) {
            md += `**4. Open in browser:** [${si.visit}](${si.visit})\n\n`;
        }
        if (si.notes) {
            md += `> 💡 ${si.notes}\n`;
        }
        addMsg(md, 'ai');
    }

    // ── Terminal helpers ──────────────────────────────────────
    function openTerminal() {
        const p = document.getElementById('terminal-panel');
        const r = document.getElementById('terminal-resizer');
        if (p) { p.style.display = 'flex'; p.dataset.mode = _termMode || 'output'; }
        if (r) { r.style.display = 'block'; }
    }
    function closeTerminal() {
        const p = document.getElementById('terminal-panel');
        const r = document.getElementById('terminal-resizer');
        if (p) p.style.display = 'none';
        if (r) r.style.display = 'none';
        _removeActiveLine();
        const chatInput = document.getElementById('chat-input');
        if (chatInput) chatInput.focus();
        // Reset to output tab when reopened
        _termMode = 'output';
    }
    function clearTerminal() {
        const out = document.getElementById('terminal-output');
        if (out) out.innerHTML = '';
        const b = document.getElementById('terminal-badge');
        if (b) { b.textContent = ''; b.className = 'terminal-badge'; }
    }
    function writeTerminal(type, text) {
        if (!text) return;
        const out = document.getElementById('terminal-output');
        if (!out) return;
        const al = document.getElementById('term-active-line');
        if (al) out.removeChild(al);
        const el = document.createElement('span');
        el.className = `term-line term-${type}`;
        el.textContent = text;
        out.appendChild(el);
        if (al && _termAlive) out.appendChild(al);
        out.scrollTop = out.scrollHeight;
    }
    function setTermBadge(type, text) {
        const b = document.getElementById('terminal-badge');
        if (!b) return;
        b.textContent = text;
        b.className = `terminal-badge ${type}`;
    }

    // ═══════════════════════════════════════════════════════════
    // MULTI-AGENT PIPELINE
    // ═══════════════════════════════════════════════════════════

    let _agentModeEnabled = false;   // force agent pipeline for all requests
    let _agentRunId = 0;             // incremented per pipeline run so cards have unique IDs

    // Agent metadata (icon, label, description)
    const AGENT_META = {
        orchestrator: { icon: '🧠', label: 'Orchestrator', color: '#a855f7' },
        intent: { icon: '🎯', label: 'Intent Classifier', color: '#6366f1' },
        intent_classification: { icon: '🎯', label: 'Intent Classifier', color: '#6366f1' },
        chat: { icon: '💬', label: 'Chat', color: '#06b6d4' },
        planning: { icon: '🗺️', label: 'Planner', color: '#8b5cf6' },
        coding: { icon: '💻', label: 'Code Generator', color: '#3b82f6' },
        reasoning: { icon: '💡', label: 'Reasoner', color: '#f59e0b' },
        reflection: { icon: '🪞', label: 'Reflection', color: '#ec4899' },
        critic: { icon: '⚖️', label: 'Critic', color: '#ef4444' },
        code_generation: { icon: '💻', label: 'Code Gen', color: '#3b82f6' },
        debugging: { icon: '🐛', label: 'Debugger', color: '#f97316' },
        refactoring: { icon: '♻️', label: 'Refactorer', color: '#10b981' },
        frontend: { icon: '🎨', label: 'Frontend', color: '#22d3ee' },
        backend: { icon: '⚙️', label: 'Backend', color: '#34d399' },
        full_stack: { icon: '⚡', label: 'Full Stack', color: '#7c3aed' },
        terminal: { icon: '🖥️', label: 'Terminal', color: '#fb923c' },
        ui_ux: { icon: '✨', label: 'UI/UX', color: '#f472b6' },
        database: { icon: '🗄️', label: 'Database', color: '#64748b' },
        security: { icon: '🛡️', label: 'Security', color: '#dc2626' },
        testing: { icon: '🧪', label: 'Testing', color: '#0ea5e9' },
        documentation: { icon: '📚', label: 'Docs', color: '#71717a' },
        deployment: { icon: '🚀', label: 'Deployment', color: '#10b981' },
        mobile_app: { icon: '📱', label: 'Mobile', color: '#8b5cf6' },
        devops: { icon: '♾️', label: 'DevOps', color: '#06b6d4' },
        data_science: { icon: '📊', label: 'Data Science', color: '#f59e0b' },
        ai_ml: { icon: '🤖', label: 'AI/ML', color: '#8b5cf6' },
        cloud_infra: { icon: '☁️', label: 'Cloud', color: '#0ea5e9' },
        refinement: { icon: '💎', label: 'Refinement', color: '#10b981' }
    };

    // ── Helper: Reload everything after agent work ───────────
    async function _reloadTree() {
        await Store.load();
        if (typeof loadProjects === 'function') await loadProjects();
    }

    // ── Create an agent card in the chat ─────────────────────
    // runId makes element IDs unique so multiple pipeline runs don't collide
    function _makeAgentCard(agentName, runId) {
        const meta = AGENT_META[agentName] || { icon: '🤖', label: agentName, color: '#22d3ee' };
        const card = document.createElement('div');
        card.className = 'agent-card';
        card.id = `ac-${runId}-${agentName}`;
        card.dataset.status = 'running';
        card.style.setProperty('--ac-color', meta.color);
        card.innerHTML = `
            <div class="ac-header">
                <span class="ac-icon">${meta.icon}</span>
                <span class="ac-name">${meta.label}</span>
                <span class="ac-spinner"></span>
                <span class="ac-elapsed" id="ac-elapsed-${runId}-${agentName}"></span>
                <span class="ac-tokens" id="ac-tokens-${runId}-${agentName}"></span>
            </div>
            <div class="ac-body">
                <div class="ac-message" id="ac-msg-${runId}-${agentName}">Starting…</div>
                <div class="ac-detail" id="ac-detail-${runId}-${agentName}"></div>
            </div>`;
        const container = document.getElementById('chat-messages');
        if (container) { container.appendChild(card); container.scrollTop = container.scrollHeight; }
        return card;
    }

    function _updateAgentCard(agentName, status, data, runId) {
        const card = document.getElementById(`ac-${runId}-${agentName}`);
        if (!card) return;
        card.dataset.status = status;
        const usage = data.usage || {};
        const tok = usage.total_tokens || 0;
        const ms = usage.elapsed_ms || 0;
        const el = document.getElementById(`ac-elapsed-${runId}-${agentName}`);
        const tk = document.getElementById(`ac-tokens-${runId}-${agentName}`);
        if (el) el.textContent = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
        if (tk) tk.textContent = tok ? `${tok.toLocaleString()} tok` : '';
        // Detail area
        const detail = document.getElementById(`ac-detail-${runId}-${agentName}`);
        if (!detail) return;
        if ((agentName === 'orchestrator' || agentName === 'planning' || agentName === 'intent_classification' || agentName === 'intent') && (data.plan || data.output)) {
            const p = data.plan || data.output;
            const tasks = p.tasks || p.roadmap || (p.selected_agents || []).map(a => ({ agent: a }));
            const taskList = tasks.map(t => {
                const agentId = typeof t === 'string' ? '' : (t.agent || '');
                const taskText = typeof t === 'string' ? t : (t.task || t.description || t.label || 'Step');
                const meta = AGENT_META[agentId];
                const label = meta ? meta.label : (agentId || taskText);
                const icon = meta ? meta.icon : (agentId ? '🤖' : '•');
                return `<span class="ac-task-item" title="${_escHtml(taskText)}">${icon} ${label}</span>`;
            }).join('');
            // Show planned file list if available (new planner format)
            const fileItems = (p.files || []).map(f =>
                `<span class="ac-file">${_escHtml(typeof f === 'string' ? f : f.path)}</span>`).join('');
            detail.innerHTML = `
                <div class="ac-thinking">${_escHtml(p.thinking || p.summary || p.intent_summary || (p.intent ? 'Intent: ' + p.intent : ''))}</div>
                ${fileItems ? `<div class="ac-files">${fileItems}</div>` : `<div class="ac-tasks">${taskList}</div>`}`;
        } else if (agentName === 'reflection' && (data.plan || data.output)) {
            const p = data.plan || data.output;
            const issues = (p.found_issues || []).map(i => `<div class="ac-issue">⚠️ ${i}</div>`).join('');
            detail.innerHTML = `<div class="ac-reflection-status ${p.is_complete ? 'ok' : 'warn'}">${p.is_complete ? '✅ Perfect' : '❌ Issues Found'}</div>${issues}`;
        } else if (data.actions?.length) {
            const files = data.actions
                .filter(a => a.action !== 'delete_file')
                .map(a => `<span class="ac-file">${_escHtml(a.file || '')}</span>`)
                .join('');
            detail.innerHTML = `<div class="ac-files">${files}</div>`;
        } else if (agentName === 'reviewer' && data.review) {
            const r = data.review;
            const scoreClass = (r.quality_score || 0) >= 80 ? 'ok' : 'warn';
            detail.innerHTML = `
                <div class="ac-review-score ${scoreClass}">Quality ${r.quality_score || '?'}/100</div>
                <div class="ac-review-summary">${_escHtml(r.summary || '')}</div>`;
        } else if (agentName === 'terminal' && data.commands?.length) {
            detail.innerHTML = `<div class="ac-cmd-count">${data.commands.length} command(s) planned</div>`;
        }
        card.querySelector('.ac-message').textContent = data.message || (status === 'done' ? 'Done' : '');
    }

    function _escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ── Render terminal command buttons ──────────────────────
    function _showCommandsCard(commands, projectName) {
        if (!commands || !commands.length) return;
        const wrap = document.createElement('div');
        wrap.className = 'agent-commands-card';
        const rows = commands.map(c => `
            <div class="acmd-item" data-cmd="${_escHtml(c.command)}" data-cwd="${_escHtml(c.cwd || projectName || '')}">
                <span class="acmd-icon">${c.icon || '▶'}</span>
                <div class="acmd-info">
                    <span class="acmd-desc">${_escHtml(c.description || c.command)}</span>
                    <code class="acmd-cmd">${_escHtml(c.command)}</code>
                </div>
                <button class="acmd-run-btn" title="Run in shell">${c.is_server ? '🚀 Start' : '▶ Run'}</button>
            </div>`).join('');
        wrap.innerHTML = `
            <div class="acmd-header">💻 Setup Commands</div>
            <div class="acmd-list">${rows}</div>`;
        wrap.querySelectorAll('.acmd-run-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const item = btn.closest('.acmd-item');
                _runCmdInShell(item.dataset.cmd, item.dataset.cwd);
                btn.textContent = '⏳';
                btn.disabled = true;
            });
        });
        const container = document.getElementById('chat-messages');
        if (container) { container.appendChild(wrap); container.scrollTop = container.scrollHeight; }
    }

    // ── Unified run: type command into shell and execute ──────
    async function _runInShell(cmd, cwd = null) {
        // Add to queue
        _termCmdQueue.push({ cmd, cwd });
        if (_termIsTyping) return; // already processing queue

        _termIsTyping = true;
        try {
            while (_termCmdQueue.length > 0) {
                const item = _termCmdQueue.shift();
                await _executeQueuedCmd(item.cmd, item.cwd);
                // Slight pause between commands
                await new Promise(r => setTimeout(r, 600));
            }
        } finally {
            _termIsTyping = false;
        }
    }

    async function _executeQueuedCmd(cmd, cwd) {
        // Switch to split or shell view and connect if needed
        const mode = (document.getElementById('terminal-panel')?.dataset.mode === 'aichat') ? 'split' : _termMode;
        openShellTerminal(mode === 'output' ? 'shell' : mode);

        // Wait for connection with timeout
        let waitCount = 0;
        while ((!_shellWS || _shellWS.readyState !== WebSocket.OPEN || !_termAlive) && waitCount < 20) {
            await new Promise(r => setTimeout(r, 300));
            waitCount++;
        }
        if (!_termAlive || !_shellWS || _shellWS.readyState !== WebSocket.OPEN) {
            console.error("Terminal not connected, skipping command");
            return;
        }

        // If command is a server (uvicorn/python app), kill any process on port 8000 first
        // ALSO: Automatically switch the preview to Proxy mode for this port!
        if (/uvicorn|python\s.*(app|main|run)/.test(cmd)) {
            const portStr = (cmd.match(/--port\s+(\d+)/) || [])[1] || '8000';
            const portNum = parseInt(portStr);

            try {
                await fetch('/api/kill-port', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ port: portNum })
                });
            } catch (_) { }

            // AUTOMATION: Switch UI to proxy mode
            Store.state.previewPort = portNum;
            Store.state.previewMode = 'proxy';
            Store.save();

            // Sync UI input
            if (UI.els['preview-port-input']) UI.els['preview-port-input'].value = portNum;
            setTimeout(() => UI.updatePreview(), 1000); // Wait for server to start before refreshing

            await new Promise(r => setTimeout(r, 400));
        }

        // If cwd is provided, navigate first.
        let targetCwd = cwd;
        if (cwd && !String(cwd).includes(':') && !String(cwd).startsWith('/') && window._ideConfig?.projects_dir) {
            const sep = window._ideConfig.os_sep || '/';
            targetCwd = window._ideConfig.projects_dir + (window._ideConfig.projects_dir.endsWith(sep) ? '' : sep) + cwd;
        }

        const isWin = window._ideConfig?.platform === 'win32';
        let fullCmd = cmd;

        if (targetCwd) {
            const cleanCwd = isWin
                ? String(targetCwd).replace(/\//g, '\\').replace(/\\\\/g, '\\')
                : String(targetCwd).replace(/\\/g, '/');

            fullCmd = isWin
                ? `cd /d "${cleanCwd}" && ${cmd}`
                : `cd "${cleanCwd}" && ${cmd}`;
        }

        // Typing effect
        return new Promise(resolve => {
            let i = 0;
            _termInput = ''; // clear current input buffer
            const type = () => {
                if (i < fullCmd.length) {
                    _termInput += fullCmd[i];
                    _updateActiveLine();
                    i++;
                    setTimeout(type, Math.random() * 15 + 10);
                } else {
                    // Send command
                    setTimeout(() => {
                        sendTermInput();
                        resolve();
                    }, 200);
                }
            };
            type();
        });
    }

    // ── Send a command through the interactive shell ──────────
    // Always opens in split view so the user sees AI chat + shell output at the same time
    function _runCmdInShell(cmd, cwd) {
        _runInShell(cmd, cwd);
    }

    // ── Pipeline summary message ──────────────────────────────
    function _showPipelineSummary(event) {
        const t = event.total_tokens || {};
        const ms = t.elapsed_ms || 0;
        const secStr = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
        const fileCount = (event.actions || []).filter(a =>
            a.action !== 'delete_file').length;
        const quality = event.review?.quality_score
            ? `  •  🔍 Quality **${event.review.quality_score}/100**` : '';
        const inTok = (t.prompt_tokens || t.input || 0).toLocaleString();
        const outTok = (t.completion_tokens || t.output || 0).toLocaleString();
        addMsg(
            `✅ **${event.message || 'Build complete'}**\n\n` +
            `📊 **Tokens:** ${inTok} in / ${outTok} out` +
            `  •  ⏱️ **${secStr}**  •  📁 **${fileCount} files**` +
            quality,
            'ai'
        );
    }

    // ── Main agent pipeline function ──────────────────────────
    async function runAgentPipeline(msg) {
        // Unique ID for this run — prevents old cards from being mistakenly updated
        const runId = ++_agentRunId;

        // Auto-derive project name if none is active
        let project = Store.state.activeProject;
        if (!project || project === '__new__') {
            project = extractProjectName(msg);
            Store.state.activeProject = project;
            Store.save();
            const sel = document.getElementById('project-select');
            if (sel) {
                if (!sel.querySelector(`option[value="${project}"]`)) {
                    const opt = new Option(project, project);
                    sel.insertBefore(opt, sel.querySelector('option[value="__new__"]'));
                }
                sel.value = project;
            }
            _setCtx(null, project);
            addMsg(`📁 Project: **${project}**`, 'ai');
        }

        // Filter files by project folder
        let contextFiles = Object.fromEntries(
            Object.entries(Store.state.files).filter(([k]) => k.startsWith(project + '/'))
        );

        let buffer = '';
        const decoder = new TextDecoder();

        try {
            const resp = await fetch('/api/agent-chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: _chatAbortCtrl?.signal,
                body: JSON.stringify({
                    message: msg,
                    files: contextFiles,
                    project_name: project,
                    model: Store.state.activeModel || null,
                    history: _getContextHistory(),
                }),
            });

            if (!resp.ok) {
                const err = await resp.text();
                throw new Error(`Server ${resp.status}: ${err}`);
            }

            const reader = resp.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                // Process all complete lines
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete last line
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const raw = line.slice(6).trim();
                    if (raw === '[DONE]') return;
                    try {
                        await _handleAgentEvent(JSON.parse(raw), project, runId);
                    } catch (pe) {
                        console.warn('Agent event parse error:', pe, raw);
                    }
                }
            }
        } catch (e) {
            if (e.name !== 'AbortError') throw e;
        }
    }

    // ── Handle individual SSE events ─────────────────────────
    async function _handleAgentEvent(event, project, runId) {
        const { event: type, agent } = event;
        switch (type) {
            case 'agent_start':
                _makeAgentCard(agent, runId);
                (document.getElementById(`ac-msg-${runId}-${agent}`) || {}).textContent = event.message || '';
                // When terminal agent starts, open split view so shell is already visible
                if (agent === 'terminal') {
                    openShellTerminal('split');
                }
                break;

            case 'agent_done': {
                _updateAgentCard(agent, 'done', event, runId);
                // Apply file actions immediately — note: actions are often nested in 'output'
                const actions = event.actions || event.output?.actions;
                if (actions?.length) {
                    const locked = lockToFolder(actions, project);
                    await applyActions(locked);
                }
                const fixActions = event.fix_actions || event.output?.fix_actions;
                if (agent === 'reviewer' && fixActions?.length) {
                    const locked = lockToFolder(fixActions, project);
                    await applyActions(locked);
                }
                break;
            }

            case 'pipeline_done':
                // Ensure split view is open — commands are about to appear and user should see the shell
                if (event.commands?.length) {
                    openShellTerminal('split');
                }
                _showCommandsCard(event.commands, project);
                _showPipelineSummary(event);
                if (event.actions && event.actions.length > 0) {
                    await _reloadTree();
                }
                Store.state.chatHistory.push({
                    role: 'assistant',
                    content: event.message || 'Build complete.',
                    ctx_folder: project,
                });
                await saveConversation();
                break;

            case 'agent_shell_kill':
                _setPortRunning(false);
                break;

            case 'agent_shell_cmd':
                _runInShell(event.command, event.cwd);
                break;

            case 'chat_text':
                // Display chat agent's response as a normal AI message
                if (event.text) {
                    addMsg(event.text, 'ai');
                    Store.state.chatHistory.push({ role: 'assistant', content: event.text, ctx_folder: project });
                    await saveConversation();
                }
                break;

            case 'error':
                addMsg(`❌ Agent error: ${event.message}`, 'ai');
                break;
        }
    }

    // ── Toggle agent mode button ──────────────────────────────
    document.getElementById('btn-agent-mode')?.addEventListener('click', () => {
        _agentModeEnabled = !_agentModeEnabled;
        const btn = document.getElementById('btn-agent-mode');
        if (btn) {
            btn.classList.toggle('active', _agentModeEnabled);
            btn.title = _agentModeEnabled ? 'Agent Mode ON — click to disable' : 'Enable Agent Mode';
        }
    });

    // ═══════════════════════════════════════════════════════════
    // END MULTI-AGENT PIPELINE
    // ═══════════════════════════════════════════════════════════

    // ── WebSocket terminal state ──────────────────────────────
    let _shellWS = null;   // shell WS
    let _termAlive = false;
    let _termMode = 'output';  // 'output' | 'shell'
    let _termInput = '';
    let _termHistory = [];
    let _histIdx = -1;
    let _termCmdQueue = [];    // queue of {cmd, cwd} for sequential typing
    let _termIsTyping = false; // lock to prevent overlapping animations

    // ── Inline prompt line helpers ────────────────────────────
    function _getActiveLine() {
        let al = document.getElementById('term-active-line');
        if (!al) {
            al = document.createElement('div');
            al.id = 'term-active-line';
            al.className = 'term-active-line';
            al.innerHTML = '<span class="term-prompt-sym"></span><span class="term-typed"></span><span class="term-cursor-blink"></span>';
            const out = document.getElementById('terminal-output');
            if (out) out.appendChild(al);
        }
        return al;
    }
    function _removeActiveLine() {
        const al = document.getElementById('term-active-line');
        if (al) al.remove();
    }
    function _updateActiveLine() {
        const al = _getActiveLine();
        const sym = al.querySelector('.term-prompt-sym');
        const text = al.querySelector('.term-typed');
        if (sym) sym.textContent = _termMode === 'shell' ? '❯ ' : '› ';
        if (text) text.textContent = _termInput;
        const out = document.getElementById('terminal-output');
        if (out) out.scrollTop = out.scrollHeight;
    }

    // ── Port 8000 indicator ───────────────────────────────────
    function _setPortRunning(running, port) {
        port = port || Store.state.previewPort || 8000;
        const btn = document.getElementById('btn-kill-port');
        if (btn) btn.style.display = running ? 'flex' : 'none';

        const openBtn = document.getElementById('btn-open-proxy');
        if (openBtn) {
            if (running) {
                // Build the URL: if we're on a real host (Render), use proxy route.
                // If localhost, open directly.
                const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
                const url = isLocal
                    ? `http://localhost:${port}/`
                    : `${location.origin}/proxy/${port}/`;
                openBtn.href = url;
                openBtn.style.display = 'flex';
            } else {
                openBtn.style.display = 'none';
            }
        }
    }

    function _setTermRunning(alive) {
        _termAlive = alive;
        if (alive) {
            _termInput = '';
            _histIdx = -1;
            _updateActiveLine();
            setTimeout(() => document.getElementById('terminal-hidden-input')?.focus(), 80);
        } else {
            _removeActiveLine();
        }
    }

    function _termAppend(text, cls) {
        if (!text) return;
        const out = document.getElementById('terminal-output');
        if (!out) return;
        // Keep active line pinned to bottom
        const al = document.getElementById('term-active-line');
        if (al) out.removeChild(al);
        const span = document.createElement('span');
        span.className = `term-${cls}`;
        span.textContent = text;
        out.appendChild(span);
        if (al && _termAlive) out.appendChild(al);
        out.scrollTop = out.scrollHeight;
        // Detect server start/stop from terminal output
        if (text.includes('Uvicorn running on') || text.includes('Application startup complete')) {
            // Try to extract port from "Uvicorn running on http://0.0.0.0:8000"
            const portMatch = text.match(/:(\d{4,5})/);
            const detectedPort = portMatch ? parseInt(portMatch[1]) : (Store.state.previewPort || 8000);
            _setPortRunning(true, detectedPort);
        } else if (text.includes('Shutdown complete') || text.includes('Application shutdown') || text.includes('[Shell session ended]') || text.includes('Finished server process')) {
            _setPortRunning(false);
        }
    }


    function sendTermInput() {
        if (!_termAlive) return;
        const text = _termInput;
        _termInput = '';
        _histIdx = -1;
        // Add to history
        if (text.trim()) { _termHistory.unshift(text); if (_termHistory.length > 50) _termHistory.pop(); }
        // Echo typed text then send
        _removeActiveLine();
        _termAppend(text + '\n', 'stdin');
        const ws = _shellWS;
        if (ws) ws.send(JSON.stringify({ type: 'stdin', data: text }));
        if (_termAlive) _updateActiveLine();
    }

    // Kill entire shell session
    function killTermProcess() {
        const ws = _shellWS;
        if (ws && _termAlive) ws.send(JSON.stringify({ type: 'kill' }));
    }

    function _setTermTabs(mode) {
        _termMode = mode;
        document.querySelectorAll('.term-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.mode === mode);
        });
        _switchTermView(mode);
    }

    function _switchTermView(mode) {
        const panel = document.getElementById('terminal-panel');
        if (panel) panel.dataset.mode = mode;

        // Auto-focus shell input if we switch to a mode that uses it
        if ((mode === 'shell' || mode === 'split') && _termAlive) {
            setTimeout(() => document.getElementById('terminal-hidden-input')?.focus(), 80);
        }
        // CSS handles all show/hide via [data-mode]
        // Reset flex-basis on shell pane when leaving split so it fills column layout normally
        if (mode !== 'split') {
            const shellPane = document.getElementById('terminal-pane-shell');
            if (shellPane) shellPane.style.flex = '';
        }
        if (mode === 'aichat') {
            if (panel && panel.offsetHeight < 320) panel.style.height = '380px';
            setTimeout(() => document.getElementById('chat-input')?.focus(), 80);
        }
        if (mode === 'split') {
            // Expand panel so both panes have room
            if (panel && panel.offsetHeight < 420) panel.style.height = '440px';
            // Scroll chat to bottom so the latest agent cards stay visible
            setTimeout(() => {
                const msgs = document.getElementById('chat-messages');
                if (msgs) msgs.scrollTop = msgs.scrollHeight;
                if (!_termAlive) {
                    document.getElementById('chat-input')?.focus();
                } else {
                    document.getElementById('terminal-hidden-input')?.focus();
                }
            }, 80);
        }
    }

    // ── Open interactive shell terminal ───────────────────────
    // targetMode: the tab mode to activate after connecting ('shell' or 'split')
    function openShellTerminal(targetMode = 'shell') {
        // If shell is already alive, just switch to target mode — don't reconnect
        if (_shellWS && _termAlive) {
            _setTermTabs(targetMode);
            openTerminal();
            return;
        }

        if (_shellWS) { try { _shellWS.close(); } catch (_) { } _shellWS = null; }

        _setTermTabs(targetMode);
        openTerminal();
        clearTerminal();
        writeTerminal('cmd', '$ Shell\n');
        setTermBadge('run', 'Connecting…');
        _setTermRunning(false);

        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}/ws/terminal`);
        _shellWS = ws;

        ws.onmessage = ({ data }) => {
            const msg = JSON.parse(data);
            if (msg.type === 'started') {
                _termAlive = true;
                _setTermRunning(true);
                setTermBadge('run', 'Shell');
            } else if (msg.type === 'stdout') {
                _termAppend(msg.data, 'out');
            } else if (msg.type === 'exit') {
                _termAlive = false;
                _shellWS = null;
                _setTermRunning(false);
                _termAppend('\n[Shell session ended]\n', 'info');
                setTermBadge('ok', 'Exited');
            }
        };
        ws.onerror = () => {
            _setTermRunning(false);
            _shellWS = null;
            // Silently retry once after 1.5s (handles backend restart timing)
            if (!ws._retried) {
                ws._retried = true;
                setTermBadge('run', 'Reconnecting…');
                setTimeout(() => openShellTerminal(targetMode), 1500);
            } else {
                _termAppend('Connection error — is the server running?\n', 'err');
                setTermBadge('err', 'Error');
            }
        };
        ws.onclose = () => {
            if (_termAlive) {
                _termAlive = false;
                _termAppend('\n[Shell disconnected]\n', 'err');
                _setTermRunning(false);
                setTermBadge('err', 'Disconnected');
                _shellWS = null;
            }
        };
    }

    // ── pip install ───────────────────────────────────────────
    async function pipInstall(pkg) {
        pkg = pkg.trim();
        if (!pkg) return;
        openTerminal();
        writeTerminal('cmd', `$ pip install ${pkg}`);
        setTermBadge('run', 'Installing…');
        try {
            const res = await fetch('/api/pip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ package: pkg })
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (data.stdout) writeTerminal('out', data.stdout);
            if (data.stderr) writeTerminal('err', data.stderr);
            const ok = data.exit_code === 0;
            setTermBadge(ok ? 'ok' : 'err', ok ? 'Installed ✓' : 'Failed');
        } catch (e) {
            writeTerminal('err', e.message);
            setTermBadge('err', 'Error');
        }
    }

    // ── Filtered history for current context ──────────────────
    function _getContextHistory() {
        const hist = Store.state.chatHistory;
        if (!_chatContextFile && !_chatContextFolder) return hist.slice(-10);

        // Keep messages that match the current context or have no context tag
        return hist.filter(h => {
            if (!h.ctx_file && !h.ctx_folder) return true; // global/untagged
            if (_chatContextFile) return h.ctx_file === _chatContextFile;
            if (_chatContextFolder) {
                return h.ctx_folder === _chatContextFolder ||
                    (h.ctx_file?.startsWith(_chatContextFolder + '/'));
            }
            return false;
        }).slice(-10);
    }

    // ── Raw API call ──────────────────────────────────────────
    async function apiChat(msg, files, signal) {
        // Auto-use current abort controller if no explicit signal passed
        const abortSignal = signal !== undefined ? signal : (_chatAbortCtrl?.signal || null);

        // Filter files by context: single file > folder > all
        let contextFiles = files;
        if (_chatContextFile && files[_chatContextFile]) {
            contextFiles = { [_chatContextFile]: files[_chatContextFile] };
        } else if (_chatContextFolder) {
            contextFiles = Object.fromEntries(
                Object.entries(files).filter(([k]) => k.startsWith(_chatContextFolder + '/'))
            );
        }

        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: abortSignal,
            body: JSON.stringify({
                message: msg,
                files: contextFiles,
                current_file: _chatContextFile || Store.state.activeFile,
                history: _getContextHistory(),
                project_name: Store.state.activeProject || null,
                model: Store.state.activeModel || null
            })
        });
        if (!res.ok) {
            const errText = await res.text();
            // Context length exceeded — mark model in dropdown
            if (res.status === 413 && errText.includes('CONTEXT_LIMIT:')) {
                const limitedModel = errText.split('CONTEXT_LIMIT:')[1]?.trim();
                _markModelLimitExceeded(limitedModel);
                throw new Error('⚠️ Model context limit exceeded. Switch to a model with more tokens (e.g. Llama 3.3 70B) or reduce project size.');
            }
            throw new Error(`Server ${res.status}: ${errText}`);
        }
        return res.json();
    }

    function _markModelLimitExceeded(modelId) {
        const sel = document.getElementById('model-select');
        if (!sel || !modelId) return;
        const opt = sel.querySelector(`option[value="${modelId}"]`);
        if (opt && !opt.dataset.limitExceeded) {
            opt.dataset.limitExceeded = '1';
            opt.textContent += ' ⚠️ Limit Exceeded';
            opt.style.color = '#f87171';
        }
    }

    // ── Apply actions to disk + UI ────────────────────────────
    async function applyActions(actions, refreshUI = true, autoLoad = false) {
        for (const a of actions) {
            if (!a.file) continue;
            if (a.action === 'add_file' || a.action === 'replace_file') {
                await Store.updateFile(a.file, a.content || '');
                if (!Store.state.openFiles.includes(a.file)) Store.state.openFiles.push(a.file);
            } else if (a.action === 'patch_file') {
                const cur = Store.state.files[a.file] || '';
                if (a.search && cur.includes(a.search)) {
                    await Store.updateFile(a.file, cur.replace(a.search, a.replace || ''));
                } else if (a.content) {
                    await Store.updateFile(a.file, a.content);
                }
            } else if (a.action === 'delete_file') {
                await Store.deleteFile(a.file);
            }
        }
        if (refreshUI) {
            Store.save();
            UI.renderFileTree();
            UI.renderTabs();
            if (autoLoad) {
                const last = actions.at(-1);
                if (last?.file && last.action !== 'delete_file' && last.file in Store.state.files) {
                    UI.loadFile(last.file);
                } else if (Store.state.activeFile) {
                    UI.loadFile(Store.state.activeFile);
                }
            }
            setTimeout(() => UI.reloadPreview(), 300);
        }
    }

    // ── Helpers ───────────────────────────────────────────────
    function setBusy(busy) {
        const btn = document.getElementById('btn-send-chat');
        const stop = document.getElementById('btn-stop-chat');
        if (!btn) return;
        btn.disabled = busy;
        btn.innerHTML = busy
            ? '<i data-lucide="loader-2" class="spin"></i>'
            : '<i data-lucide="arrow-up"></i>';
        if (stop) stop.style.display = busy ? 'flex' : 'none';
        lucide.createIcons();

        const container = document.getElementById('chat-messages');
        if (!container) return;
        if (busy) {
            if (!document.getElementById('chat-thinking')) {
                const thinking = document.createElement('div');
                thinking.id = 'chat-thinking';
                thinking.className = 'msg ai thinking-msg';
                thinking.innerHTML =
                    '<span class="msg-icon">⚡</span>' +
                    '<div class="thinking-dots"><span></span><span></span><span></span></div>';
                container.appendChild(thinking);
                container.scrollTop = container.scrollHeight;
            }
        } else {
            document.getElementById('chat-thinking')?.remove();
        }
    }

    function addMsg(text, role, extraClass) {
        const wrap = document.createElement('div');
        wrap.className = `msg ${role}${extraClass ? ' ' + extraClass : ''}`;

        if (role === 'ai') {
            const icon = document.createElement('span');
            icon.className = 'msg-icon';
            icon.textContent = '⚡';
            wrap.appendChild(icon);

            const body = document.createElement('div');
            body.className = 'msg-body';
            if (typeof marked !== 'undefined') {
                body.innerHTML = marked.parse(text || '');
            } else {
                body.textContent = text || '';
            }
            wrap.appendChild(body);

            if (typeof hljs !== 'undefined') {
                body.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
            }
        } else {
            const body = document.createElement('div');
            body.className = 'msg-body';
            body.textContent = text || '';
            wrap.appendChild(body);
        }

        const container = document.getElementById('chat-messages');
        if (container) {
            container.appendChild(wrap);
            container.scrollTop = container.scrollHeight;
        }
        return wrap;
    }

    // Auto-grow chat input
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.addEventListener('input', () => {
            chatInput.style.height = 'auto';
            chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
        });
    }

    // ── Model management ─────────────────────────────────────
    async function loadModels() {
        const select = document.getElementById('model-select');
        if (!select) return;
        try {
            const res = await fetch('/api/models');
            if (!res.ok) return;
            const models = await res.json();
            select.innerHTML = models.map(m =>
                `<option value="${m.id}" title="${m.description}">${m.display}${m.recommended ? ' ⭐' : ''} (${Math.round(m.max_tokens / 1024)}K)</option>`
            ).join('');
            // Restore saved model — fall back to first option if not found
            const saved = Store.state.activeModel;
            const exists = saved && [...select.options].some(o => o.value === saved);
            if (exists) {
                select.value = saved;
            } else {
                Store.state.activeModel = select.value;
                Store.save();
            }
        } catch (e) { console.error('loadModels error', e); }
    }

    document.getElementById('model-select')?.addEventListener('change', e => {
        Store.state.activeModel = e.target.value;
        Store.save();
        // Clear any limit-exceeded styling on the other model when user switches
        const opts = document.querySelectorAll('#model-select option');
        opts.forEach(opt => {
            if (opt.value !== e.target.value && opt.dataset.limitExceeded) {
                delete opt.dataset.limitExceeded;
                opt.style.color = '';
                opt.textContent = opt.textContent.replace(' ⚠️ Limit Exceeded', '');
            }
        });
    });

    // ── Project management ────────────────────────────────────

    async function loadProjects() {
        const select = document.getElementById('project-select');
        if (!select) return;
        try {
            const res = await fetch('/api/projects');
            if (!res.ok) return;
            const projects = await res.json();
            select.innerHTML =
                '<option value="">— All Projects —</option>' +
                projects.map(p =>
                    `<option value="${p.name}">${p.name}${p.file_count ? ' (' + p.file_count + ' files)' : ''}</option>`
                ).join('') +
                '<option value="__new__">➕ New Project…</option>';
            if (Store.state.activeProject) select.value = Store.state.activeProject;
        } catch (e) { console.error('loadProjects error', e); }
    }

    async function switchProject(name) {
        Store.state.activeProject = name;
        Store.save();
        const select = document.getElementById('project-select');
        if (select) select.value = name;

        // Auto-set file context to the project folder (or clear if "All Projects")
        _setCtx(null, name || null);

        // Clear chat display
        const msgs = document.getElementById('chat-messages');
        if (msgs) msgs.innerHTML = '';
        Store.state.chatHistory = [];

        if (!name) return;

        // Load server conversation history for this project
        try {
            const res = await fetch(`/api/projects/${encodeURIComponent(name)}/history`);
            if (!res.ok) return;
            const data = await res.json();
            Store.state.chatHistory = data.messages || [];

            if (Store.state.chatHistory.length === 0) return;

            // Show up-to last 20 messages in chat
            const start = Math.max(0, Store.state.chatHistory.length - 20);
            if (start > 0 && msgs) {
                const notice = document.createElement('div');
                notice.className = 'msg ai';
                notice.textContent = `↑ ${start} earlier messages hidden — ${Store.state.chatHistory.length} total`;
                msgs.appendChild(notice);
            }
            Store.state.chatHistory.slice(start).forEach(m => {
                addMsg(m.content, m.role === 'user' ? 'user' : 'ai');
            });
        } catch (e) { console.error('switchProject error', e); }
    }

    async function saveConversation() {
        const project = Store.state.activeProject;
        if (!project) return;
        try {
            await fetch(`/api/projects/${encodeURIComponent(project)}/history`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: Store.state.chatHistory })
            });
        } catch (e) { console.error('saveConversation error', e); }
    }

    // Project dropdown change → switch project or enter "new project" mode
    document.getElementById('project-select')?.addEventListener('change', async e => {
        const val = e.target.value;
        if (val === '__new__') {
            // Set pending state — folder name comes from user's first message
            Store.state.activeProject = '__new__';
            Store.state.chatHistory = [];
            Store.save();

            // Clear context until folder is known
            _setCtx(null, null);

            // Make sure terminal panel is open on AI Chat tab
            openTerminal();
            _setTermTabs('aichat');

            // Clear chat and show instruction
            const msgs = document.getElementById('chat-messages');
            if (msgs) msgs.innerHTML = '';
            addMsg('📁 **New project mode.** Describe what you want to build — I\'ll name the folder automatically and start building.', 'ai');
            document.getElementById('chat-input')?.focus();
        } else {
            await switchProject(val);
        }
    });

    // Load models and project list on startup
    await loadModels();
    await loadProjects();
    if (Store.state.activeProject) await switchProject(Store.state.activeProject);
});
// ── GitHub Modal Logic ────────────────────────────────────
function openGitHubModal() {
    const modal = document.getElementById('github-modal');
    const projSelect = document.getElementById('gh-project-select');
    const repoInput = document.getElementById('gh-repo-name');
    if (!modal || !projSelect) return;

    modal.style.display = 'flex';

    // Fill projects
    fetch('/api/projects')
        .then(res => res.json())
        .then(projects => {
            projSelect.innerHTML = projects.map(p =>
                `<option value="${p.name}" ${p.name === Store.state.activeProject ? 'selected' : ''}>${p.name}</option>`
            ).join('');

            if (!repoInput.value) repoInput.value = projSelect.value;
        });

    projSelect.onchange = () => { repoInput.value = projSelect.value; };
    document.getElementById('github-status').textContent = '';
}

async function publishToGitHub() {
    const btn = document.getElementById('btn-do-publish');
    const status = document.getElementById('github-status');
    const projectName = document.getElementById('gh-project-select').value;
    const repoName = document.getElementById('gh-repo-name').value;
    const isPrivate = document.getElementById('gh-is-private').checked;
    const user = document.getElementById('gh-user').value;
    const token = document.getElementById('gh-token').value;

    if (!projectName) return;

    btn.disabled = true;
    btn.textContent = 'Publishing...';
    status.style.color = '#a1a1aa';
    status.textContent = 'Creating repo and pushing code...';

    try {
        const res = await fetch('/api/github/publish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                project_name: projectName,
                repo_name: repoName,
                is_private: isPrivate,
                github_user: user || undefined,
                github_token: token || undefined
            })
        });

        const data = await res.json();
        if (res.ok) {
            status.style.color = '#4ade80';
            status.innerHTML = `✅ ${data.message} <a href="${data.repo_url}" target="_blank" style="color:#8b5cf6; text-decoration:none;">View on GitHub</a>`;
            btn.textContent = 'Success!';
            setTimeout(() => {
                btn.disabled = false;
                btn.textContent = 'Publish to GitHub';
            }, 3000);
        } else {
            throw new Error(data.detail || 'Publish failed');
        }
    } catch (e) {
        status.style.color = '#f87171';
        status.textContent = `❌ Error: ${e.message}`;
        btn.disabled = false;
        btn.textContent = 'Retry Publish';
    }
}
