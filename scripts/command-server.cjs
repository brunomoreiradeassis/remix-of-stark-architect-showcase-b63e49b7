const express = require('express');
const { spawn } = require('child_process');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Rota raiz para evitar 404 e permitir verificação de status
app.get('/', (req, res) => {
    res.json({ 
        status: 'online', 
        message: 'BuilderAI Command Server is running',
        endpoints: {
            prepare: '/prepare-project (POST)',
            save: '/save-file (POST)',
            execute: '/execute (POST)',
            status: '/status (GET)'
        }
    });
});

// Fluxo inteligente: instala se necessário e inicia 'dev', com logs contínuos
app.post('/smart-dev', async (req, res) => {
    const { cwd, packageManager } = req.body || {};
    if (!cwd) {
        return res.status(400).json({ error: 'Diretório (cwd) é obrigatório' });
    }

    // Encerra dev anterior, se houver
    if (currentProcess) {
        try { currentProcess.kill(); } catch (e) {}
        currentProcess = null;
    }

    const pm = (() => {
        if (packageManager) return packageManager;
        try {
            if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
            if (fs.existsSync(path.join(cwd, 'package-lock.json'))) return 'npm';
        } catch {}
        return 'pnpm';
    })();

    const nodeModulesPath = path.join(cwd, 'node_modules');
    const needsInstall = !fs.existsSync(nodeModulesPath);

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');

    function pipe(child) {
        child.stdout.on('data', (d) => res.write(d.toString()));
        child.stderr.on('data', (d) => res.write(d.toString()));
    }

    // Executa instalação se necessário
    async function runInstallIfNeeded() {
        if (!needsInstall) {
            res.write('INFO: node_modules encontrado. Pulando instalação.\n');
            return 0;
        }
        res.write('INFO: node_modules ausente. Iniciando instalação...\n');
        return await new Promise((resolve) => {
            const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
            const args = process.platform === 'win32'
                ? ['-Command', `${pm} install`]
                : ['-c', `${pm} install`];
            const installProc = spawn(shell, args, { cwd, env: process.env, shell: true });
            pipe(installProc);
            installProc.on('close', (code) => {
                res.write(`INSTALL_CLOSE: ${code}\n`);
                resolve(code || 0);
            });
        });
    }

    const installCode = await runInstallIfNeeded();
    if (installCode !== 0) {
        res.write('ERROR: Falha na instalação de dependências.\n');
        return res.end();
    }

    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const args = process.platform === 'win32'
        ? ['-Command', `${pm} run dev`]
        : ['-c', `${pm} run dev`];
    const devProc = spawn(shell, args, { cwd, env: process.env, shell: true });
    currentProcess = devProc;

    pipe(devProc);
    devProc.on('close', (code) => {
        res.write(`CLOSE: ${code}\n`);
        res.end();
        currentProcess = null;
    });
    devProc.on('error', (err) => {
        res.write(`ERROR: ${err.message}\n`);
        res.end();
        currentProcess = null;
    });
});

const PORT = 3001;
const PROJECTS_ROOT = path.join(process.cwd(), 'Projetos');

// Garante que a pasta "Projetos" exista
if (!fs.existsSync(PROJECTS_ROOT)) {
    try {
        fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
        console.log(`Pasta "Projetos" criada em: ${PROJECTS_ROOT}`);
    } catch (err) {
        console.error(`Erro ao criar pasta "Projetos": ${err.message}`);
    }
}

let currentProcess = null;

// Rota para preparar o diretório de um projeto
app.post('/prepare-project', (req, res) => {
    const { projectName } = req.body;
    if (!projectName) {
        return res.status(400).json({ error: 'Nome do projeto é obrigatório' });
    }

    const projectDir = path.join(PROJECTS_ROOT, projectName);
    
    try {
        if (!fs.existsSync(projectDir)) {
            fs.mkdirSync(projectDir, { recursive: true });
            console.log(`Nova subpasta de projeto criada: ${projectDir}`);
        }
        res.json({ 
            success: true, 
            path: projectDir,
            name: projectName
        });
    } catch (err) {
        console.error(`Erro ao criar subpasta do projeto: ${err.message}`);
        res.status(500).json({ error: `Erro ao criar diretório do projeto: ${err.message}` });
    }
});

// Rota para salvar arquivos na pasta do projeto
app.post('/save-file', (req, res) => {
    const { projectName, filePath, content } = req.body;
    
    if (!projectName || !filePath) {
        return res.status(400).json({ error: 'projectName e filePath são obrigatórios' });
    }

    const projectDir = path.join(PROJECTS_ROOT, projectName);
    const fullPath = path.join(projectDir, filePath);
    
    try {
        // Garante que o diretório do arquivo exista
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(fullPath, content, 'utf8');
        res.json({ success: true, path: fullPath });
    } catch (err) {
        console.error(`Erro ao salvar arquivo ${filePath}: ${err.message}`);
        res.status(500).json({ error: `Erro ao salvar arquivo: ${err.message}` });
    }
});

// Rota para ler arquivos de um projeto dentro de "Projetos"
app.post('/read-project', (req, res) => {
    const { projectName } = req.body;
    if (!projectName) {
        return res.status(400).json({ error: 'projectName é obrigatório' });
    }

    const projectDir = path.join(PROJECTS_ROOT, projectName);
    if (!fs.existsSync(projectDir)) {
        return res.status(404).json({ error: 'Projeto não encontrado em Projetos/' + projectName });
    }

    const allowed = /\.(tsx|ts|js|jsx|css|json|html|md|txt)$/i;
    const denyDirs = new Set(['node_modules', '.git', 'dist', '.vite', 'build', '.next']);
    const files = [];

    function scan(dir, base) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const rel = base ? path.join(base, entry.name) : entry.name;
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (denyDirs.has(entry.name)) continue;
                scan(abs, rel);
            } else {
                if (allowed.test(entry.name)) {
                    try {
                        const code = fs.readFileSync(abs, 'utf8');
                        // Normaliza separadores para '/' para o preview
                        files.push({ path: rel.replace(/\\/g, '/'), code });
                    } catch (err) {
                        console.warn('Falha ao ler', abs, err.message);
                    }
                }
            }
        }
    }

    try {
        scan(projectDir, '');
        res.json({ success: true, files, path: projectDir });
    } catch (err) {
        console.error('Erro ao ler projeto:', err.message);
        res.status(500).json({ error: 'Erro ao ler projeto: ' + err.message });
    }
});

app.post('/execute', (req, res) => {
    const { command, cwd } = req.body;

    if (!command || !cwd) {
        return res.status(400).json({ error: 'Comando e diretório (cwd) são obrigatórios' });
    }

    // Se já houver um processo rodando (como um dev server), mata ele antes de rodar outro
    if (currentProcess) {
        try {
            currentProcess.kill();
        } catch (e) {}
    }

    console.log(`Executando: ${command} em ${cwd}`);

    // Configura a execução via PowerShell no Windows
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const args = process.platform === 'win32' ? ['-Command', command] : ['-c', command];

    const child = spawn(shell, args, {
        cwd: cwd,
        env: process.env,
        shell: true
    });

    currentProcess = child;

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');

    child.stdout.on('data', (data) => {
        res.write(`STDOUT: ${data.toString()}`);
    });

    child.stderr.on('data', (data) => {
        res.write(`STDERR: ${data.toString()}`);
    });

    child.on('close', (code) => {
        res.write(`CLOSE: ${code}`);
        res.end();
        currentProcess = null;
    });

    child.on('error', (err) => {
        res.write(`ERROR: ${err.message}`);
        res.end();
        currentProcess = null;
    });
});

// Rota raiz para evitar "Cannot GET /"
app.get('/', (req, res) => {
    res.json({ 
        message: 'BuilderAI Command Server is running',
        endpoints: {
            status: '/status',
            prepare: '/prepare-project (POST)',
            execute: '/execute (POST)'
        }
    });
});

// Rota para verificar se um diretório existe dentro do cwd
app.post('/check-dir', (req, res) => {
    const { cwd, dirName } = req.body;
    if (!cwd || !dirName) {
        return res.status(400).json({ error: 'cwd e dirName são obrigatórios' });
    }
    const fullPath = path.join(cwd, dirName);
    res.json({ exists: fs.existsSync(fullPath), path: fullPath });
});

// Lista chats salvos de um projeto (.builderai/chats/)
app.post('/list-chats', (req, res) => {
    const { projectName } = req.body;
    if (!projectName) return res.status(400).json({ error: 'projectName é obrigatório' });

    const chatsDir = path.join(PROJECTS_ROOT, projectName, '.builderai', 'chats');
    if (!fs.existsSync(chatsDir)) {
        return res.json({ chats: [] });
    }

    try {
        const files = fs.readdirSync(chatsDir)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                const fullPath = path.join(chatsDir, f);
                const stat = fs.statSync(fullPath);
                let meta = { title: f.replace('.json', ''), id: f.replace('.json', '') };
                try {
                    const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                    if (data.title) meta.title = data.title;
                    if (data.id) meta.id = data.id;
                } catch {}
                return { ...meta, updatedAt: stat.mtime.toISOString(), filename: f };
            })
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        res.json({ chats: files });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Lê um chat específico
app.post('/read-chat', (req, res) => {
    const { projectName, chatId } = req.body;
    if (!projectName || !chatId) return res.status(400).json({ error: 'projectName e chatId são obrigatórios' });

    const chatPath = path.join(PROJECTS_ROOT, projectName, '.builderai', 'chats', `${chatId}.json`);
    if (!fs.existsSync(chatPath)) {
        return res.status(404).json({ error: 'Chat não encontrado' });
    }

    try {
        const data = JSON.parse(fs.readFileSync(chatPath, 'utf8'));
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rota para verificar se o servidor está online
app.get('/status', (req, res) => {
    res.json({ status: 'online', platform: process.platform });
});

app.listen(PORT, () => {
    console.log(`Servidor de comandos BuilderAI rodando em http://localhost:${PORT}`);
    console.log(`Pronto para executar comandos via PowerShell.`);
});
