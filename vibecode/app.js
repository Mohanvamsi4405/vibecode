let editor;
let currentFile = 'index.html';
let files = {
    'index.html': `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f0f2f5; }
        .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; }
        h1 { color: #1e293b; margin-bottom: 0.5rem; }
        p { color: #64748b; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Hello World</h1>
        <p>Edit this code or ask the AI to change it!</p>
    </div>
    <script>
        console.log('Preview loaded');
    </script>
</body>
</html>`,
    'style.css': '/* Global styles */',
    'script.js': '// App logic'
};

// Initialize Monaco Editor
require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });
require(['vs/editor/editor.main'], function () {
    editor = monaco.editor.create(document.getElementById('monaco-container'), {
        value: files[currentFile],
        language: 'html',
        theme: 'vs-dark',
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 14,
    });

    // Update VFS on change
    editor.onDidChangeModelContent(() => {
        files[currentFile] = editor.getValue();
        updatePreview();
    });

    renderFileList();
    updatePreview();
});

// Safe Lucide helper
function initIcons() {
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    } else {
        console.warn('Lucide is not loaded yet.');
    }
}

// Virtual File System Logic
function renderFileList() {
    const fileList = document.getElementById('file-list');
    fileList.innerHTML = '';
    Object.keys(files).forEach(filename => {
        const li = document.createElement('li');
        li.className = `file-item ${filename === currentFile ? 'active' : ''}`;
        li.innerHTML = `<i data-lucide="file-code"></i> <span>${filename}</span>`;
        li.onclick = () => switchFile(filename);
        fileList.appendChild(li);
    });
    initIcons();
}

function switchFile(filename) {
    currentFile = filename;
    document.getElementById('current-filename').innerText = filename;

    // Determine language
    let lang = 'javascript';
    if (filename.endsWith('.html')) lang = 'html';
    if (filename.endsWith('.css')) lang = 'css';

    const model = monaco.editor.createModel(files[filename], lang);
    editor.setModel(model);

    renderFileList();
}

// Live Preview logic
function updatePreview() {
    const iframe = document.getElementById('preview-iframe');
    let html = files['index.html'] || '';
    const css = files['style.css'] || '';
    const js = files['script.js'] || '';

    let combined = html;

    // Inject Lucide into preview if it's likely to be used but missing
    if (!combined.includes('lucide') && (combined.includes('data-lucide') || js.includes('lucide'))) {
        const lucideScript = '<script src="https://unpkg.com/lucide@latest"></script>';
        if (combined.includes('</head>')) {
            combined = combined.replace('</head>', `${lucideScript}</head>`);
        } else {
            combined = lucideScript + combined;
        }
    }

    // Inject CSS
    if (combined.includes('</head>')) {
        combined = combined.replace('</head>', `<style>${css}</style></head>`);
    } else {
        combined += `<style>${css}</style>`;
    }

    // Inject JS
    const jsInjection = `<script>${js}<\/script>`;
    if (combined.includes('</body>')) {
        combined = combined.replace('</body>', `${jsInjection}</body>`);
    } else {
        combined += jsInjection;
    }

    // Ensure icons are created in iframe after a short delay
    if (combined.includes('lucide')) {
        combined = combined.replace('</body>', '<script>setTimeout(() => { if(window.lucide) { lucide.createIcons(); } }, 200);</script></body>');
    }

    iframe.srcdoc = combined;
}

// Chat & AI Integration
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
let messageHistory = [];

async function sendMessage() {
    const message = chatInput.value.trim();
    if (!message) return;

    appendMessage('user', message);
    messageHistory.push({ role: 'user', content: message });
    chatInput.value = '';

    try {
        appendMessage('assistant', 'Thinking...', true);

        // Ensure we use the correct API URL
        const apiUrl = window.location.origin === 'null' ? 'http://localhost:8000/chat' : '/chat';

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: message,
                files: files,
                history: messageHistory
            })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({ detail: 'Unknown Server Error' }));
            throw new Error(errData.detail || `Server responded with ${response.status}`);
        }

        const data = await response.json();
        removeLoadingMessage();

        if (data.actions) {
            applyActions(data.actions);
            if (data.message) {
                appendMessage('assistant', data.message);
                messageHistory.push({ role: 'assistant', content: data.message });
            }
        } else {
            appendMessage('assistant', 'I received a response but no actions were found.');
        }

        // Limit history to save tokens and avoid 429 errors
        if (messageHistory.length > 20) {
            messageHistory = messageHistory.slice(-20);
        }
    } catch (error) {
        removeLoadingMessage();
        let errorMsg = 'Could not connect to backend.';
        if (window.location.protocol === 'file:') {
            errorMsg = 'Error: You are opening index.html directly. Please visit http://localhost:8000 instead.';
        } else if (error.message) {
            errorMsg = `Error: ${error.message}`;
        }
        appendMessage('assistant', errorMsg);
        console.error('Connection Error:', error);
    }
}

function appendMessage(role, text, isLoading = false) {
    const div = document.createElement('div');
    div.className = `message ${role} ${isLoading ? 'loading' : ''}`;
    div.innerText = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeLoadingMessage() {
    const loading = chatMessages.querySelector('.loading');
    if (loading) loading.remove();
}

function applyActions(actions) {
    actions.forEach(action => {
        if (action.action === 'replace_file' || action.action === 'add_file') {
            files[action.file] = action.content;
        } else if (action.action === 'delete_file') {
            delete files[action.file];
        }
    });

    // Refresh current view if the current file was changed
    if (files[currentFile]) {
        editor.setValue(files[currentFile]);
    } else {
        // Fallback to index.html if current was deleted
        switchFile('index.html');
    }

    renderFileList();
    updatePreview();
}

sendBtn.onclick = sendMessage;
chatInput.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
};

document.getElementById('refresh-preview').onclick = updatePreview;

// Popup Preview Window
let popupWindow = null;

function openPopupPreview() {
    // Get the current preview content
    const iframe = document.getElementById('preview-iframe');
    const previewContent = iframe.srcdoc;

    // Close existing popup if open
    if (popupWindow && !popupWindow.closed) {
        popupWindow.close();
    }

    // Calculate popup size (80% of screen)
    const width = Math.floor(screen.width * 0.8);
    const height = Math.floor(screen.height * 0.8);
    const left = Math.floor((screen.width - width) / 2);
    const top = Math.floor((screen.height - height) / 2);

    // Open new popup window
    popupWindow = window.open(
        '',
        'PreviewWindow',
        `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
    );

    if (popupWindow) {
        // Write the preview content to the popup
        popupWindow.document.open();
        popupWindow.document.write(previewContent);
        popupWindow.document.close();
        popupWindow.document.title = 'Live Preview - ' + currentFile;

        // Auto-update popup when preview changes
        const originalUpdatePreview = updatePreview;
        window.updatePreview = function () {
            originalUpdatePreview();
            if (popupWindow && !popupWindow.closed) {
                setTimeout(() => {
                    const updatedContent = document.getElementById('preview-iframe').srcdoc;
                    popupWindow.document.open();
                    popupWindow.document.write(updatedContent);
                    popupWindow.document.close();
                }, 100);
            }
        };
    } else {
        alert('Popup blocked! Please allow popups for this site.');
    }
}

document.getElementById('popup-preview').onclick = openPopupPreview;
