
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import * as net from 'node:net';
import { pathToFileURL } from 'node:url';


interface RunningPreviewServer {
	process: ReturnType<typeof spawn>;
	url: string;
	projectPath: string;
}

async function getAvailablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();

		server.once('error', reject);

		server.listen(0, '127.0.0.1', () => {
			const address = server.address();

			if (!address || typeof address === 'string') {
				server.close();
				reject(new Error('Could not allocate a local port.'));
				return;
			}

			const port = address.port;

			server.close(error => {
				if (error) {
					reject(error);
				} else {
					resolve(port);
				}
			});
		});
	});
}

async function runNpmCommand(
	projectPath: string,
	args: string[]
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const isWindows = process.platform === 'win32';

		const child = spawn(
			isWindows ? 'npm.cmd' : 'npm',
			args,
			{
				cwd: projectPath,
				shell: isWindows,
				stdio: 'inherit'
			}
		);

		child.once('error', reject);

		child.once('close', code => {
			if (code === 0) {
				resolve();
			} else {
				reject(
					new Error(`npm ${args.join(' ')} exited with code ${code}.`)
				);
			}
		});
	});
}

async function waitForServer(
	url: string,
	child: ReturnType<typeof spawn>,
	timeoutMs = 30_000
): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(
				`The development server exited with code ${child.exitCode}.`
			);
		}

		try {
			const response = await fetch(url);

			if (response.ok) {
				return;
			}
		} catch {
			// The server may still be starting.
		}

		await new Promise(resolve => setTimeout(resolve, 400));
	}

	throw new Error('The development server did not start within 30 seconds.');
}

function stopPreviewServer(
	child: ReturnType<typeof spawn>
): void {
	if (child.exitCode !== null || child.killed) {
		return;
	}

	if (process.platform === 'win32' && child.pid) {
		execFile(
			'taskkill',
			['/pid', String(child.pid), '/T', '/F'],
			() => {
				// The process may already have exited.
			}
		);
	} else {
		child.kill('SIGTERM');
	}
}

async function createVcnViteConfig(
	projectPath: string,
	outputChannel: vscode.OutputChannel
): Promise<string> {
	const configPath = path.join(
		projectPath,
		'.vcn-preview.config.mjs'
	);

	const possibleConfigs = [
		'vite.config.js',
		'vite.config.mjs',
		'vite.config.ts'
	];

	let originalConfigPath: string | undefined;

	for (const name of possibleConfigs) {
		const candidate = path.join(projectPath, name);

		try {
			await fs.access(candidate);
			originalConfigPath = candidate;
			break;
		} catch {
			// Try the next supported config filename.
		}
	}


	const inspectorScript = `
	(() => {
		if (window.__vcnInspectorInstalled) return;
		window.__vcnInspectorInstalled = true;

		const style = document.createElement('style');
		style.textContent = [
			'.vcn-react-selected { outline: 3px solid #ff8c42 !important; outline-offset: 3px !important; }',
			'#vcn-react-inspector { position:fixed; right:16px; bottom:16px; z-index:2147483647; width:290px; max-height:75vh; overflow:auto; box-sizing:border-box; padding:14px; border-radius:10px; background:#171923; color:white; font:12px/1.6 monospace; box-shadow:0 5px 25px #0005; }',
			'#vcn-react-inspector strong { color:#ffb27d; }',
			'.vcn-row { display:grid; grid-template-columns:105px 1fr; gap:8px; align-items:center; margin-top:9px; }',
			'.vcn-row input { box-sizing:border-box; width:100%; min-width:0; }',
			'.vcn-row input[type=color] { height:30px; padding:2px; }',
			'.vcn-row input[type=text] { padding:5px; color:#171923; }',
			'.vcn-actions { display:flex; gap:8px; margin-top:12px; }',
			'.vcn-actions button { padding:6px 10px; cursor:pointer; }',
			'.vcn-muted { color:#b8bdcc; margin-top:5px; }'
		].join('');

		document.head.appendChild(style);

		const panel = document.createElement('div');
		panel.id = 'vcn-react-inspector';

		const properties = [
			{ label: 'Background', css: 'background-color', type: 'color' },
			{ label: 'Text color', css: 'color', type: 'color' },
			{ label: 'Font size', css: 'font-size', type: 'text' },
			{ label: 'Padding', css: 'padding', type: 'text' },
			{ label: 'Border radius', css: 'border-radius', type: 'text' }
		];

		let selected = null;
		let originalInlineStyles = {};

		function colorToHex(value) {
			const match = value.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/i);
			if (!match) return '#ffffff';

			return '#' + match.slice(1, 4)
				.map(part => Number(part).toString(16).padStart(2, '0'))
				.join('');
		}

		function makeRow(property) {
			const row = document.createElement('label');
			row.className = 'vcn-row';

			const label = document.createElement('span');
			label.textContent = property.label;

			const input = document.createElement('input');
			input.type = property.type;
			input.dataset.cssProperty = property.css;

			input.addEventListener('input', () => {
				if (!selected) return;

				selected.style.setProperty(property.css, input.value);
			});

			row.append(label, input);
			return row;
		}

		function renderInspector() {
			panel.replaceChildren();

			const title = document.createElement('strong');
			title.textContent = 'VISUAL CODE NAVIGATOR';

			const info = document.createElement('div');
			info.textContent = selected
				? 'Selected: ' + selected.tagName.toLowerCase()
				: 'Click any element to inspect it.';

			const hint = document.createElement('div');
			hint.className = 'vcn-muted';
			hint.textContent = 'Changes apply to this live preview only.';

			panel.append(title, info, hint);

			for (const property of properties) {
				panel.appendChild(makeRow(property));
			}

			const actions = document.createElement('div');
			actions.className = 'vcn-actions';

			const undo = document.createElement('button');
			undo.textContent = 'Undo changes';
			undo.disabled = !selected;

			undo.addEventListener('click', () => {
				if (!selected) return;

				for (const property of properties) {
					const original = originalInlineStyles[property.css];

					if (original) {
						selected.style.setProperty(property.css, original);
					} else {
						selected.style.removeProperty(property.css);
					}
				}

				renderInspector();
				loadCurrentStyles();
			});

			const deselect = document.createElement('button');
			deselect.textContent = 'Deselect';

			deselect.addEventListener('click', () => {
				if (selected) {
					selected.classList.remove('vcn-react-selected');
				}

				selected = null;
				originalInlineStyles = {};
				renderInspector();
			});

			actions.append(undo, deselect);
			panel.appendChild(actions);
		}

		function loadCurrentStyles() {
			if (!selected) return;

			const computed = getComputedStyle(selected);

			for (const property of properties) {
				const input = panel.querySelector(
					'[data-css-property="' + property.css + '"]'
				);

				if (!input) continue;

				const value = computed.getPropertyValue(property.css).trim();

				input.value = property.type === 'color'
					? colorToHex(value)
					: value;
			}
		}

		document.addEventListener('click', event => {
			const target = event.target;

			if (!(target instanceof Element)) return;
			if (target.closest('#vcn-react-inspector')) return;
			if (event.ctrlKey) return;

			event.preventDefault();
			event.stopImmediatePropagation();

			if (selected) {
				selected.classList.remove('vcn-react-selected');
			}

			selected = target;
			selected.classList.add('vcn-react-selected');
			const source = selected.getAttribute('data-vcn-source');
			console.log('[VCN selected source]', source);

			if (source) {
				window.parent.postMessage({
					type: 'vcnOpenSource',
					source
				},'*');
			}

			originalInlineStyles = {};

			for (const property of properties) {
				originalInlineStyles[property.css] =
					selected.style.getPropertyValue(property.css);
			}

			renderInspector();
			loadCurrentStyles();
		}, true);

		document.body.appendChild(panel);
		renderInspector();
	})();
	`;


	const originalImport = originalConfigPath
		? `import originalConfig from ${JSON.stringify(
			pathToFileURL(originalConfigPath).href
		)};`
		: '';

	const configSource = `
        import { mergeConfig } from 'vite';
		import { parse } from '@babel/parser';
		${originalImport}
	
        const inspectorScript = ${JSON.stringify(inspectorScript)};
		
		const inspectorPlugin = {
		name: 'visual-code-navigator-inspector',
		apply: 'serve',
		enforce: 'pre',

		
		transform(code, id) {
		const cleanId = id.split('?')[0];

		if (
			!/\.[jt]sx$/.test(cleanId) ||
			cleanId.includes('node_modules')
		) {
			return null;
		}

		try {
		
			
		console.log('[VCN INPUT CHECK]', cleanId, 'first 12 lines:', code.split(String.fromCharCode(10)).slice(0, 12).map(function(line, i) { return String(i + 1) + ': ' + line; }).join(String.fromCharCode(10)));


			const ast = parse(code, {
			sourceType: 'module',
			plugins: ['jsx', 'typescript', 'decorators-legacy']
			});

			const edits = [];

			function visit(node) {
			if (!node || typeof node !== 'object') return;

			if (node.type === 'JSXOpeningElement') {
				const hasMarker = node.attributes?.some(
				(attribute) =>
					attribute.type === 'JSXAttribute' &&
					attribute.name?.type === 'JSXIdentifier' &&
					attribute.name.name === 'data-vcn-source'
				);

				if (!hasMarker && Number.isInteger(node.start) &&
					Number.isInteger(node.end) && node.loc?.start.line) {
				const value = JSON.stringify(
					cleanId + ':' + node.loc.start.line
				);

				// Insert before ">" or before "/" in a self-closing tag.
				const insertAt = node.selfClosing
					? node.end - 2
					: node.end - 1;

				
				const marker = node.selfClosing
				? ' data-vcn-source={' + value + '} '
				: ' data-vcn-source={' + value + '}';


				edits.push({ insertAt, marker });
				}
			}

			for (const [key, value] of Object.entries(node)) {
				if (key === 'loc' || key === 'start' || key === 'end' ||
					key === 'extra' || key === 'comments' || key === 'tokens') {
				continue;
				}

				if (Array.isArray(value)) {
				for (const child of value) visit(child);
				} else if (value && typeof value === 'object') {
				visit(value);
				}
			}
			}

			visit(ast);

			// Apply edits from right to left so earlier offsets stay valid.
			edits.sort((a, b) => b.insertAt - a.insertAt);

			let transformed = code;

			for (const edit of edits) {
			transformed =
				transformed.slice(0, edit.insertAt) +
				edit.marker +
				transformed.slice(edit.insertAt);
			}

			console.log(
			'[VCN markers injected]',
			cleanId,
			'count:',
			edits.length
			);

			// No generator and no rewritten source map.
			return {
			code: transformed,
			map: null
			};
		} catch (error) {
			console.error(
			'[VCN transform failed]',
			cleanId,
			error.message
			);

			return null;
		}
		},


		transformIndexHtml() {
			return [{
			tag: 'script',
			children: inspectorScript,
			injectTo: 'body'
			}];
		}
		};


        export default async (env) => {
            const original = ${originalConfigPath
			? `typeof originalConfig === 'function'
                        ? await originalConfig(env)
                        : originalConfig`
			: '{}'
		};

            
		const baseConfig = original || {};
		const merged = mergeConfig(baseConfig, {});

		const existingPlugins = Array.isArray(merged.plugins)
		? merged.plugins
		: merged.plugins
			? [merged.plugins]
			: [];

		merged.plugins = [
		inspectorPlugin,
		...existingPlugins
		];

		return merged;

        };
    `;

	await fs.writeFile(configPath, configSource, 'utf8');
	outputChannel.appendLine(
		`Created temporary Vite config: ${configPath}`
	);
	return configPath;
}

async function detectRunningServers(
	outputChannel: vscode.OutputChannel
): Promise<string[]> {
	const ports = [
		3000, 4173, 4200, 4321,
		5173, 5174, 5175, 5176,
		5177, 5178, 5179, 5180,
		8080
	];

	const results = await Promise.all(
		ports.map(async port => {
			for (const host of ['127.0.0.1', '[::1]']) {
				const url = `http://${host}:${port}`;

				try {
					const response = await fetch(url, {
						signal: AbortSignal.timeout(3000)
					});

					outputChannel.appendLine(
						`[VCN Detection] ${url} -> HTTP ${response.status}`
					);

					return response.status > 0
						? `http://localhost:${port}`
						: null;
				} catch (error) {
					const err = error as Error & {
						cause?: Error & { code?: string };
					};

					outputChannel.appendLine(
						`[VCN Detection] ${url} -> FAILED: ` +
						`${err.cause?.code ?? err.message}`
					);
				}
			}

			return null;
		})
	);

	return results.filter(
		(url): url is string => url !== null
	);
}
async function openPreviewPanel(
	context: vscode.ExtensionContext,
	projectPath: string,
	url: string,
	outputChannel: vscode.OutputChannel,
	serverProcess?: ReturnType<typeof spawn>,
	title = 'Visual Code Navigator Preview'
): Promise<void> {
	const panel = vscode.window.createWebviewPanel(
		'visualCodeNavigatorPreview',
		title,
		vscode.ViewColumn.One,
		{
			enableScripts: true
		}
	);

	const nonce = [...Array(32)]
		.map(() => Math.random().toString(36).slice(2, 3))
		.join('');

	panel.webview.html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta
                http-equiv="Content-Security-Policy"
                content="
                    default-src 'none';
                    script-src 'nonce-${nonce}';
                    frame-src ${url};
                    style-src 'unsafe-inline';
                "
            >
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                html, body {
                    margin: 0;
                    padding: 0;
                    width: 100%;
                    height: 100%;
                    overflow: hidden;
                }

                iframe {
                    display: block;
                    width: 100%;
                    height: 100%;
                    border: 0;
                }
            </style>
        </head>
        <body>
            <iframe
                id="vcn-preview-frame"
                src="${url}"
                title="Website preview"
            ></iframe>

            <script nonce="${nonce}">
                const vscode = acquireVsCodeApi();
                const frame = document.getElementById('vcn-preview-frame');

                window.addEventListener('message', (event) => {
                    if (event.source !== frame.contentWindow) return;

                    const message = event.data;

                    if (
                        message?.type === 'vcnOpenSource' &&
                        typeof message.source === 'string'
                    ) {
                        vscode.postMessage({
                            type: 'vcnOpenSource',
                            source: message.source
                        });
                    }
                });
            </script>
        </body>
        </html>
    `;

	panel.webview.onDidReceiveMessage(async (message) => {
		if (
			message?.type !== 'vcnOpenSource' ||
			typeof message.source !== 'string'
		) {
			return;
		}

		const match = message.source.match(/^(.*):(\d+)$/);

		if (!match) { return; }

		const filePath = path.resolve(match[1]);
		const line = Number(match[2]);

		const relativePath = path.relative(projectPath, filePath);

		if (
			relativePath.startsWith('..') ||
			path.isAbsolute(relativePath)
		) {
			vscode.window.showWarningMessage(
				'Source file is outside the selected project.'
			);
			return;
		}

		try {
			const document = await vscode.workspace.openTextDocument(
				vscode.Uri.file(filePath)
			);

			const editor = await vscode.window.showTextDocument(
				document,
				vscode.ViewColumn.Beside
			);

			const position = new vscode.Position(
				Math.max(0, Math.min(line - 1, document.lineCount - 1)),
				0
			);

			editor.selection = new vscode.Selection(position, position);

			editor.revealRange(
				new vscode.Range(position, position),
				vscode.TextEditorRevealType.InCenter
			);
		} catch (error) {
			vscode.window.showErrorMessage(
				`Could not open source file: ${String(error)}`
			);
		}
	});

	panel.onDidDispose(() => {
		if (serverProcess) {
			stopPreviewServer(serverProcess);
		}
	});

	context.subscriptions.push({
		dispose: () => {
			if (serverProcess) {
				stopPreviewServer(serverProcess);
			}
		}
	});

	outputChannel.appendLine(`Preview available at ${url}`);
}

async function startReactVitePreview(
	context: vscode.ExtensionContext,
	projectFolder: vscode.Uri,
	outputChannel: vscode.OutputChannel
): Promise<void> {
	async function findReactViteApps(
		root: vscode.Uri
	): Promise<vscode.Uri[]> {
		const results: vscode.Uri[] = [];
		const ignored = new Set([
			'node_modules', '.git', 'dist', 'build',
			'coverage', '.next', '.vite'
		]);

		async function scan(folder: vscode.Uri): Promise<void> {
			const entries = await fs.readdir(folder.fsPath, {
				withFileTypes: true
			});

			const packageEntry = entries.find(
				entry => entry.isFile() && entry.name === 'package.json'
			);

			if (packageEntry) {
				try {
					const packagePath = path.join(
						folder.fsPath,
						'package.json'
					);

					const data = JSON.parse(
						await fs.readFile(packagePath, 'utf8')
					);

					const dependencies = {
						...data.dependencies,
						...data.devDependencies
					};

					if (
						dependencies.react &&
						dependencies.vite &&
						data.scripts?.dev
					) {
						results.push(folder);
					}
				} catch {
					// Ignore unreadable package files and keep scanning.
				}
			}

			for (const entry of entries) {
				if (!entry.isDirectory() || ignored.has(entry.name)) {
					continue;
				}

				await scan(vscode.Uri.joinPath(folder, entry.name));
			}
		}

		await scan(root);
		return results;
	}
	const apps = await findReactViteApps(projectFolder);

	if (apps.length === 0) {
		vscode.window.showErrorMessage(
			'No React + Vite app with a dev script was found in this folder.'
		);
		return;
	}

	let selectedApp = apps[0];

	if (apps.length > 1) {
		const choice = await vscode.window.showQuickPick(
			apps.map(app => ({
				label: path.relative(
					projectFolder.fsPath,
					app.fsPath
				).replace(/\\/g, '/') || '.',
				description: 'React + Vite app',
				uri: app
			})),
			{ placeHolder: 'Choose which React app to preview' }
		);

		if (!choice) {
			return;
		}

		selectedApp = choice.uri;
	}

	const projectPath = selectedApp.fsPath;
	const packagePath = path.join(projectPath, 'package.json');
	let packageData: {
		scripts?: Record<string, string>;
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};

	try {
		packageData = JSON.parse(
			await fs.readFile(packagePath, 'utf8')
		);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : String(error);

		vscode.window.showErrorMessage(
			`Could not read package.json: ${message}`
		);

		outputChannel.appendLine(
			`Package JSON read failed: ${message}`
		);

		return;
	}

	const dependencies = {
		...packageData.dependencies,
		...packageData.devDependencies
	};

	if (!dependencies.react || !dependencies.vite) {
		vscode.window.showErrorMessage(
			'This preview currently requires a React + Vite project.'
		);
		return;
	}

	if (!packageData.scripts?.dev) {
		vscode.window.showErrorMessage(
			'No "dev" script found in package.json.'
		);
		return;
	}

	const nodeModulesPath = path.join(projectPath, 'node_modules');

	try {
		await fs.access(nodeModulesPath);
	} catch {
		const choice = await vscode.window.showWarningMessage(
			'Dependencies are missing. Install this project’s dependencies?',
			'Install dependencies',
			'Cancel'
		);

		if (choice !== 'Install dependencies') {
			return;
		}

		try {
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Installing project dependencies...',
					cancellable: false
				},
				async () => {
					await runNpmCommand(projectPath, ['install']);
				}
			);
		} catch (error) {
			vscode.window.showErrorMessage(
				`Dependency installation failed: ${String(error)}`
			);
			return;
		}
	}

	let port: number;

	try {
		port = await getAvailablePort();
	} catch (error) {
		vscode.window.showErrorMessage(
			`Could not find a free port: ${String(error)}`
		);
		return;
	}

	const url = `http://localhost:${port}`;

	const isWindows = process.platform === 'win32';
	const vcnConfigPath = await createVcnViteConfig(
		projectPath,
		outputChannel
	);

	await fs.access(vcnConfigPath);
	const serverProcess = spawn(
		isWindows ? 'npm.cmd' : 'npm',
		[
			'run',
			'dev',
			'--',
			'--config',
			vcnConfigPath,
			'--host',
			'127.0.0.1',
			'--port',
			String(port),
			'--strictPort'
		],
		{
			cwd: projectPath,
			shell: isWindows,
			stdio: 'pipe'
		}
	);

	const logServerOutput = (data: Buffer) => {
		outputChannel.appendLine(`[Vite] ${data.toString().trimEnd()}`);
	};

	serverProcess.stdout?.on('data', logServerOutput);
	serverProcess.stderr?.on('data', logServerOutput);

	try {
		await waitForServer(url, serverProcess);
	} catch (error) {
		stopPreviewServer(serverProcess);

		vscode.window.showErrorMessage(
			`Could not start the React preview: ${String(error)}`
		);

		outputChannel.show(true);
		return;
	}

	await openPreviewPanel(
		context,
		projectPath,
		url,
		outputChannel,
		serverProcess,
		'Visual Code Navigator — React Preview'
	);
}


export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel(
		'Visual Code Navigator'
	);
	outputChannel.appendLine(
		'Visual Code Navigator extension activated; CSS navigation diagnostics enabled.'
	);
	context.subscriptions.push(outputChannel);

	const helloCommand = vscode.commands.registerCommand(
		'visual-code-navigator.helloWorld',
		() => {
			vscode.window.showInformationMessage(
				'Visual Code Navigator is ready!'
			);
		}
	);

	const openProjectCommand = vscode.commands.registerCommand(
		'visual-code-navigator.openProject',
		async () => {
			const folders = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				openLabel: 'Open Website Project'
			});

			if (!folders?.length) {
				return;
			}

			const projectFolder = folders[0];

			const detectedProject = await detectProject(projectFolder);

			outputChannel.appendLine(
				`Detected project type: ${detectedProject.kind}`
			);

			outputChannel.appendLine(
				`HTML files found: ${detectedProject.htmlFiles.length}`
			);

			if (detectedProject.kind === 'react-vite') {
				await startReactVitePreview(
					context,
					projectFolder,
					outputChannel
				);
				return;
			}

			if (detectedProject.kind === 'react') {
				vscode.window.showInformationMessage(
					'React detected, but this preview currently supports React + Vite only.'
				);
				return;
			}

			if (detectedProject.htmlFiles.length === 0) {
				vscode.window.showErrorMessage(
					'No HTML entry file found. React/Vite projects are detected ' +
					'separately; other framework support will be added later.'
				);
				return;
			}

			let indexFile: vscode.Uri;

			if (detectedProject.htmlFiles.length === 1) {
				indexFile = detectedProject.htmlFiles[0];
			} else {
				const selectedHtml = await vscode.window.showQuickPick(
					detectedProject.htmlFiles.map(file => ({
						label: path.relative(
							projectFolder.fsPath,
							file.fsPath
						).replace(/\\/g, '/'),
						description: 'HTML entry file',
						uri: file
					})),
					{
						placeHolder: 'Choose the HTML page to preview'
					}
				);

				if (!selectedHtml) {
					return;
				}

				indexFile = selectedHtml.uri;
			}

			const panel = vscode.window.createWebviewPanel(
				'visualCodeNavigator',
				'Visual Code Navigator Preview',
				vscode.ViewColumn.One,
				{
					enableScripts: true,
					localResourceRoots: [projectFolder]
				}
			);

			const projectBaseUri = panel.webview.asWebviewUri(
				vscode.Uri.file(projectFolder.fsPath + path.sep)
			);

			const htmlFolder = path.dirname(indexFile.fsPath);

			const baseUri = panel.webview.asWebviewUri(
				vscode.Uri.file(htmlFolder + path.sep)
			);

			const originalHtml = await fs.readFile(
				indexFile.fsPath,
				'utf8'
			);

			panel.webview.html = buildPreviewHtml(
				panel.webview,
				originalHtml,
				baseUri.toString()
			);


			panel.webview.onDidReceiveMessage(
				async message => {
					if (message.command === 'cssDiagnostic') {
						if (typeof message.message === 'string') {
							outputChannel.appendLine(
								`[Webview] ${message.message}`
							);
						}
						return;
					}

					if (message.command !== 'elementSelected') {
						return;
					}

					const candidates = Array.isArray(message.cssCandidates)
						? message.cssCandidates
						: [];
					outputChannel.appendLine(
						`Received elementSelected for <${String(message.tag ?? 'unknown')}> with ${candidates.length} CSS candidate(s).`
					);

					const sourceLine = message.sourceLine;

					if (
						!Number.isInteger(sourceLine) ||
						sourceLine < 1
					) {
						vscode.window.showWarningMessage(
							'Could not locate this element in the HTML source.'
						);
						return;
					}

					try {
						// Build a list of source locations the user can choose from.
						const choices: {
							label: string;
							description: string;
							uri: vscode.Uri;
							line: number;
						}[] = [
								{
									label: '$(code) Open HTML source',
									description: `${path.relative(projectFolder.fsPath, indexFile.fsPath)
										.replace(/\\/g, '/')
										}:${sourceLine}`,
									uri: indexFile,
									line: sourceLine
								}
							];

						// Check CSS candidates sent by the webview.
						for (const candidate of candidates) {
							if (
								typeof candidate.href !== 'string' ||
								typeof candidate.selector !== 'string'
							) {
								outputChannel.appendLine(
									'Ignored malformed CSS candidate from the Webview.'
								);
								continue;
							}

							outputChannel.appendLine(
								`Resolving CSS candidate "${candidate.selector}" from "${candidate.href}".`
							);
							const result = await findCssSource(
								projectFolder,
								projectBaseUri.toString(),
								candidate.href,
								candidate.selector,
								messageText =>
									outputChannel.appendLine(`[CSS] ${messageText}`)
							);

							if (result) {
								const relativePath = path.relative(
									projectFolder.fsPath,
									result.uri.fsPath
								);
								outputChannel.appendLine(
									`Resolved CSS candidate to ${relativePath}:${result.line}.`
								);

								choices.push({
									label: `$(symbol-color) CSS: ${candidate.selector}`,
									description: `${relativePath}:${result.line}`,
									uri: result.uri,
									line: result.line
								});
							}
						}
						outputChannel.appendLine(
							`Showing Quick Pick with ${choices.length - 1} CSS source option(s).`
						);
						// Find the JavaScript source associated with the selected element.
						const elementId =
							typeof message.id === 'string' ? message.id : '';

						if (elementId) {
							const jsResult = await findJavaScriptSource(
								projectFolder,
								elementId
							);

							if (jsResult) {
								const relativePath = path.relative(
									projectFolder.fsPath,
									jsResult.uri.fsPath
								);

								outputChannel.appendLine(
									`Resolved JavaScript source to ${relativePath}:${jsResult.line}.`
								);

								choices.push({
									label: `$(symbol-event) JS: ${elementId}`,
									description: `${relativePath}:${jsResult.line} — ${jsResult.description}`,
									uri: jsResult.uri,
									line: jsResult.line
								});
							}
						}
						// Let the user choose HTML or a matching CSS rule.
						const selected = await vscode.window.showQuickPick(
							choices,
							{
								placeHolder: 'Choose the source you want to inspect'
							}
						);

						if (!selected) {
							return;
						}

						// Open the chosen source file.
						const document =
							await vscode.workspace.openTextDocument(selected.uri);

						const lineIndex = Math.min(
							selected.line - 1,
							document.lineCount - 1
						);

						const editor = await vscode.window.showTextDocument(
							document,
							{
								viewColumn: vscode.ViewColumn.Beside,
								preview: true
							}
						);

						const lineRange = document.lineAt(lineIndex).range;

						editor.selection = new vscode.Selection(
							lineRange.start,
							lineRange.end
						);

						editor.revealRange(
							lineRange,
							vscode.TextEditorRevealType.InCenter
						);
					} catch (error) {
						vscode.window.showErrorMessage(
							`Could not open the source: ${String(error)}`
						);
					}
				},
				undefined,
				context.subscriptions
			);

		}
	);
	const connectToServerCommand = vscode.commands.registerCommand(
		'visual-code-navigator.connectToServer',
		async () => {
			const servers = await detectRunningServers(outputChannel);

			let selectedUrl: string | undefined;

			if (servers.length === 1) {
				selectedUrl = servers[0];
			} else if (servers.length > 1) {
				selectedUrl = await vscode.window.showQuickPick(
					servers,
					{
						placeHolder: 'Choose a running local website'
					}
				);
			} else {
				selectedUrl = await vscode.window.showInputBox({
					prompt: 'Enter your running website URL',
					placeHolder: 'http://localhost:5173',
					validateInput: value => {
						try {
							const parsed = new URL(value);

							if (
								parsed.protocol !== 'http:' &&
								parsed.protocol !== 'https:'
							) {
								return 'Only HTTP and HTTPS URLs are supported.';
							}

							return undefined;
						} catch {
							return 'Enter a valid URL.';
						}
					}
				});
			}

			if (!selectedUrl) {
				return;
			}

			const projectFolder =
				vscode.workspace.workspaceFolders?.[0];

			if (!projectFolder) {
				vscode.window.showErrorMessage(
					'Open a project folder first.'
				);
				return;
			}

			await openPreviewPanel(
				context,
				projectFolder.uri.fsPath,
				selectedUrl,
				outputChannel,
				undefined,
				'Visual Code Navigator Preview'
			);
		}
	);
	context.subscriptions.push(
		helloCommand,
		openProjectCommand,
		connectToServerCommand
	);
}

export function buildPreviewHtml(
	webview: vscode.Webview,
	originalHtml: string,
	baseUri: string
): string {
	const nonce = getNonce();

	// Add source line markers before inserting our own HTML.
	let html = addSourceMarkers(originalHtml);

	const baseTag =
		`<base href="${escapeAttribute(baseUri)}">`;

	const inspectorStyles = `
        .vcn-selected {
            outline: 3px solid #ff8c42 !important;
            outline-offset: 3px !important;
        }

        #vcn-inspector {
            position: fixed;
            right: 16px;
            bottom: 16px;
            z-index: 2147483647;
            max-width: 300px;
            padding: 14px;
            border-radius: 10px;
            background: #171923;
            color: white;
            font: 12px/1.6 monospace;
            overflow-wrap: anywhere;
            box-shadow: 0 5px 25px #0005;
        }

        #vcn-inspector strong {
            color: #ffb27d;
        }
    `;

	const inspectorMarkup = `
        <div id="vcn-inspector">
            <strong>VISUAL CODE NAVIGATOR</strong>
            <div>Click an element to inspect it.</div>
        </div>
    `;

	const selectionScript = `
        const vscode = acquireVsCodeApi();
        const inspector = document.getElementById('vcn-inspector');
        let selectedElement = null;

		function reportCssDiagnostic(message) {
			console.warn('[Visual Code Navigator]', message);
			vscode.postMessage({
				command: 'cssDiagnostic',
				message
			});
		}

		function splitSelectorList(selectorText) {
			const selectors = [];
			let start = 0;
			let depth = 0;
			let quote = '';
			let escaped = false;

			for (let index = 0; index < selectorText.length; index++) {
				const character = selectorText[index];
				if (escaped) {
					escaped = false;
					continue;
				}
				if (character === '\\\\') {
					escaped = true;
					continue;
				}
				if (quote) {
					if (character === quote) quote = '';
					continue;
				}
				if (character === '"' || character === "'") {
					quote = character;
				} else if (character === '(' || character === '[') {
					depth++;
				} else if (character === ')' || character === ']') {
					depth--;
				} else if (character === ',' && depth === 0) {
					selectors.push(selectorText.slice(start, index).trim());
					start = index + 1;
				}
			}
			selectors.push(selectorText.slice(start).trim());
			return selectors.filter(Boolean);
		}

		function findMatchingCssRules(target) {
			const matches = [];
			const inspectedSheets = new Set();

			function inspectRules(rules, href) {
				for (const rule of rules) {
					if (rule instanceof CSSImportRule && rule.styleSheet) {
						try {
							inspectSheet(rule.styleSheet);
						} catch (error) {
							reportCssDiagnostic(
								'Could not inspect imported stylesheet ' +
									rule.href + ': ' + String(error)
							);
						}
						continue;
					}

					let nestedRules;
					try {
						nestedRules = rule.cssRules;
					} catch (error) {
						reportCssDiagnostic(
							'Could not inspect nested CSS rules in ' +
								href + ': ' + String(error)
						);
						continue;
					}
					if (rule.selectorText && rule.style) {
						const selectors = splitSelectorList(rule.selectorText);

						for (const selector of selectors) {
							const baseSelector = selector
								.replace(/::before\b|::after\b|::marker\b/g, '')
								.trim();

							if (!baseSelector) continue;

							try {
								if (target.matches(baseSelector)) {
									matches.push({
										href,
										selector
									});
								}
							} catch (error) {
								reportCssDiagnostic(
									'Could not match CSS selector "' + selector +
										'" from ' + href + ': ' + String(error)
								);
							}
						}
					}

					if (nestedRules && nestedRules.length > 0) {
						inspectRules(nestedRules, href);
					}
				}
			}

			function inspectSheet(sheet) {
				if (inspectedSheets.has(sheet)) return;
				inspectedSheets.add(sheet);

				const owner = sheet.ownerNode;
				const ownerHref = owner instanceof HTMLLinkElement
					? owner.getAttribute('href')
					: null;
				const href = sheet.href || ownerHref;

				if (!href) {
					if (!(owner instanceof HTMLStyleElement)) {
						reportCssDiagnostic(
							'Skipped a stylesheet without a source file URL.'
						);
					}
					return;
				}

				try {
					const rules = sheet.cssRules;
					console.log(
						'[Visual Code Navigator] Inspecting stylesheet',
						{ href, resolvedHref: sheet.href, ruleCount: rules.length }
					);
					reportCssDiagnostic(
						'Inspecting stylesheet href="' + href +
							'", sheet.href="' + (sheet.href || 'none') +
							'", owner="' + (owner ? owner.nodeName : 'none') +
							'", ruleCount=' + rules.length + '.'
					);
					const matchesBefore = matches.length;
					inspectRules(rules, href);
					reportCssDiagnostic(
						'Finished stylesheet inspection; ' +
							(matches.length - matchesBefore) +
							' matching selector(s) found.'
					);
				} catch (error) {
					reportCssDiagnostic(
						'Could not read CSS rules from ' + href +
							' (resolved URL: ' + (sheet.href || 'unknown') +
							'): ' + String(error)
					);
				}
			}

			for (const sheet of document.styleSheets) {
				inspectSheet(sheet);
			}
			console.log(
				'[Visual Code Navigator] CSS inspection complete',
				{ stylesheetCount: document.styleSheets.length, matches }
			);
			return matches;
		}


        document.addEventListener('click', (event) => {
            const target = event.target;

            if (!(target instanceof Element)) {
                return;
            }

            if (target.closest('#vcn-inspector')) {
                return;
            }

			// Ctrl + click: allow normal website interaction.
			if (event.ctrlKey) {
				return;
			}

			// Normal clicks are for inspection, not website interaction.
			event.preventDefault();
			event.stopImmediatePropagation();

            // Find the closest element connected to an HTML source line.
            const sourceElement = target.closest(
                '[data-vcn-source-line]'
            );

            if (!sourceElement) {
                return;
            }

            if (selectedElement) {
                selectedElement.classList.remove('vcn-selected');
            }

            selectedElement = target;
            selectedElement.classList.add('vcn-selected');

            const details = {
                command: 'elementSelected',
                sourceLine: Number(
                    sourceElement.getAttribute('data-vcn-source-line')
                ),
                tag: target.tagName.toLowerCase(),
                id: target.id,
                classes: typeof target.className === 'string'
                    ? target.className
                    : '',
                text: (target.innerText || target.textContent || '')
                    .trim()
                    .slice(0, 200),

				cssCandidates: findMatchingCssRules(target)
            };

			
			const inspectorWasHidden =
				inspector.dataset.hidden === 'true';

            
			inspector.replaceChildren();

			const title = document.createElement('strong');
			title.textContent = 'SELECTED ELEMENT';

			const hideButton = document.createElement('button');
			hideButton.textContent = 'Hide';
			hideButton.type = 'button';
			hideButton.style.cssText =
				'float:right; cursor:pointer; margin-left:12px;';

			hideButton.addEventListener('click', () => {
				inspector.dataset.hidden = 'true';
				inspector.style.display = 'none';

				showInspectorButton.style.display = 'block';
			});

			const info = document.createElement('div');
			info.textContent = '<' + details.tag + '> ' +
				(details.id ? '#' + details.id : '');

			const classInfo = document.createElement('div');
			classInfo.textContent = 'Classes: ' +
				(details.classes || 'None');

			const textInfo = document.createElement('div');
			textInfo.textContent = 'Text: ' +
				(details.text || 'None');

			const lineInfo = document.createElement('div');
			lineInfo.textContent = 'HTML line: ' +
				details.sourceLine;

			inspector.append(
				title,
				hideButton,
				info,
				classInfo,
				textInfo,
				lineInfo
			);

			if (inspectorWasHidden) {
				inspector.style.display = 'none';
				showInspectorButton.style.display = 'block';
			}


            vscode.postMessage(details);
        }, true);
		const showInspectorButton = document.createElement('button');

		showInspectorButton.textContent = 'Show Inspector';
		showInspectorButton.type = 'button';
		showInspectorButton.style.cssText =
			'position: fixed;' +
			'bottom: 12px;' +
			'right: 12px;' +
			'z-index: 2147483647;' +
			'display: none;' +
			'padding: 8px 12px;' +
			'cursor: pointer;';

		showInspectorButton.addEventListener('click', () => {
			inspector.dataset.hidden = 'false';
			inspector.style.display = 'block';
			showInspectorButton.style.display = 'none';
		});

		document.body.appendChild(showInspectorButton);

    `;

	const additions = `
        <style>${inspectorStyles}</style>
        ${inspectorMarkup}
        <script nonce="${nonce}">${selectionScript}</script>
    `;

	// Make relative CSS, JavaScript and image paths resolve.
	if (/<head(?:\s[^>]*)?>/i.test(html)) {
		html = html.replace(
			/<head(?:\s[^>]*)?>/i,
			match => `${match}\n${baseTag}`
		);
	} else {
		html = `${baseTag}${html}`;
	}

	// Insert the inspector near the end of the website body.
	if (/<\/body\s*>/i.test(html)) {
		html = html.replace(
			/<\/body\s*>/i,
			`${additions}</body>`
		);
	} else {
		html += additions;
	}

	const csp = `
        <meta http-equiv="Content-Security-Policy"
            content="default-src 'none';
            img-src ${webview.cspSource} https: data:;
            style-src ${webview.cspSource} 'unsafe-inline' https:;
            script-src ${webview.cspSource} 'nonce-${nonce}' 'unsafe-inline' https:;
            font-src ${webview.cspSource} https: data:;
            connect-src ${webview.cspSource} https:;">
    `;

	if (/<head(?:\s[^>]*)?>/i.test(html)) {
		html = html.replace(
			/<head(?:\s[^>]*)?>/i,
			match => `${match}\n${csp}`
		);
	}

	return html;
}


type ProjectKind = 'static-html' | 'react-vite' | 'react' | 'unknown';

interface DetectedProject {
	kind: ProjectKind;
	htmlFiles: vscode.Uri[];
	hasPackageJson: boolean;
	reactViteFolders: vscode.Uri[];
	reactFolders: vscode.Uri[];
}

async function detectProject(
	projectFolder: vscode.Uri
): Promise<DetectedProject> {
	const ignoredDirectories = new Set([
		'node_modules',
		'.git',
		'dist',
		'build',
		'coverage',
		'.next',
		'.vite',
		'out'
	]);

	const htmlFiles: vscode.Uri[] = [];
	const reactViteFolders: vscode.Uri[] = [];
	const reactFolders: vscode.Uri[] = [];

	let hasPackageJson = false;

	async function scanDirectory(directory: string): Promise<void> {
		let entries;

		try {
			entries = await fs.readdir(directory, {
				withFileTypes: true
			});
		} catch {
			return;
		}

		for (const entry of entries) {
			const fullPath = path.join(directory, entry.name);

			if (entry.isDirectory()) {
				if (!ignoredDirectories.has(entry.name)) {
					await scanDirectory(fullPath);
				}
				continue;
			}

			if (!entry.isFile()) {
				continue;
			}

			if (/\.html?$/i.test(entry.name)) {
				htmlFiles.push(vscode.Uri.file(fullPath));
			}

			if (entry.name !== 'package.json') {
				continue;
			}

			try {
				const packageText = await fs.readFile(fullPath, 'utf8');
				const packageData = JSON.parse(packageText);

				hasPackageJson = true;

				const dependencies = {
					...packageData.dependencies,
					...packageData.devDependencies
				};

				const hasReact = Boolean(dependencies.react);
				const hasVite = Boolean(dependencies.vite);

				const appFolder = vscode.Uri.file(
					path.dirname(fullPath)
				);

				if (hasReact && hasVite) {
					reactViteFolders.push(appFolder);
				} else if (hasReact) {
					reactFolders.push(appFolder);
				}
			} catch {
				// Ignore malformed package.json files.
			}
		}
	}

	await scanDirectory(projectFolder.fsPath);

	htmlFiles.sort((a, b) => {
		const aRelative = path.relative(
			projectFolder.fsPath, a.fsPath
		).replace(/\\/g, '/');

		const bRelative = path.relative(
			projectFolder.fsPath, b.fsPath
		).replace(/\\/g, '/');

		const score = (relativePath: string) => {
			if (relativePath === 'index.html') { return 0; }
			if (path.posix.basename(relativePath) === 'index.html') {
				return 1;
			}
			return 2;
		};

		return score(aRelative) - score(bRelative)
			|| aRelative.localeCompare(bRelative);
	});

	let kind: ProjectKind = 'unknown';

	if (reactViteFolders.length > 0) {
		kind = 'react-vite';
	} else if (reactFolders.length > 0) {
		kind = 'react';
	} else if (htmlFiles.length > 0) {
		kind = 'static-html';
	}

	return {
		kind,
		htmlFiles,
		hasPackageJson,
		reactViteFolders,
		reactFolders
	};
}

function addSourceMarkers(html: string): string {
	// Skip comments and entire script/style blocks so that tag-like
	// strings inside them are not mistaken for HTML elements.
	const tokenPattern =
		/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<![^>]*>|<\/?[a-zA-Z][\w:-]*(?:\s[^<>]*?)?>/gi;

	return html.replace(
		tokenPattern,
		(match, offset: number) => {
			// Ignore comments, declarations and closing tags.
			if (
				match.startsWith('<!--') ||
				match.startsWith('<!') ||
				match.startsWith('</')
			) {
				return match;
			}

			// Script/style blocks were matched as complete tokens.
			if (/^<(script|style)\b/i.test(match)) {
				return match;
			}

			const lineNumber =
				html.slice(0, offset).split('\n').length;

			// Preserve self-closing tag syntax.
			if (match.endsWith('/>')) {
				return match.slice(0, -2) +
					` data-vcn-source-line="${lineNumber}"/>`;
			}

			return match.slice(0, -1) +
				` data-vcn-source-line="${lineNumber}">`;
		}
	);
}

export async function findCssSource(
	projectFolder: vscode.Uri,
	baseUri: string,
	href: string,
	selector: string,
	reportDiagnostic: (message: string) => void
): Promise<{ uri: vscode.Uri; line: number } | undefined> {
	try {
		const projectUrl = new URL(baseUri);
		const stylesheetUrl = new URL(href, projectUrl);
		const projectPath = projectUrl.pathname.endsWith('/')
			? projectUrl.pathname
			: `${projectUrl.pathname}/`;
		let relativeUrlPath: string;

		if (
			stylesheetUrl.protocol !== projectUrl.protocol ||
			stylesheetUrl.host !== projectUrl.host
		) {
			reportDiagnostic(
				`Stylesheet URL "${href}" resolves outside the selected project and cannot be opened as a local CSS file.`
			);
			return undefined;
		}

		if (stylesheetUrl.pathname.startsWith(projectPath)) {
			relativeUrlPath = decodeURIComponent(
				stylesheetUrl.pathname.slice(projectPath.length)
			);
		} else if (stylesheetUrl.pathname.startsWith('/')) {
			relativeUrlPath = decodeURIComponent(
				stylesheetUrl.pathname.slice(1)
			);
		} else {
			reportDiagnostic(
				`Stylesheet URL "${href}" does not map to a path inside the selected project.`
			);
			return undefined;
		}

		if (!relativeUrlPath) {
			reportDiagnostic(`Stylesheet URL "${href}" does not identify a file.`);
			return undefined;
		}

		const cssPath = path.resolve(
			projectFolder.fsPath,
			...relativeUrlPath.split('/').filter(Boolean)
		);

		const relativePath = path.relative(
			projectFolder.fsPath,
			cssPath
		);

		// Never read files outside the selected project.
		if (
			relativePath.startsWith('..') ||
			path.isAbsolute(relativePath)
		) {
			reportDiagnostic(
				`Stylesheet URL "${href}" resolves outside the selected project.`
			);
			return undefined;
		}

		const uri = vscode.Uri.file(cssPath);
		const css = await fs.readFile(cssPath, 'utf8');

		const selectorPattern = selector
			.split(/(\s+)/)
			.map(part => /^\s+$/.test(part)
				? '\\s+'
				: part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
			.join('');
		const pattern = new RegExp(
			`(^|[{},])([\\t\\r\\n ]*)(${selectorPattern})(?=[\\t\\r\\n ]*(?:,|\\{))`,
			'm'
		);
		const match = pattern.exec(css);

		if (!match || match.index === undefined) {
			reportDiagnostic(
				`Could not find selector "${selector}" in ${relativePath}.`
			);
			return undefined;
		}

		const selectorOffset =
			match.index + match[1].length + match[2].length;

		const line = css
			.slice(0, selectorOffset)
			.split('\n').length;

		return { uri, line };

	} catch (error) {
		reportDiagnostic(
			`Could not resolve CSS source "${href}" for selector "${selector}": ${String(error)}`
		);
		return undefined;
	}
}

interface JavaScriptSource {
	uri: vscode.Uri;
	line: number;
	description: string;
}

export async function findJavaScriptSource(
	projectFolder: vscode.Uri,
	elementId: string
): Promise<JavaScriptSource | undefined> {
	if (!elementId) {
		return undefined;
	}

	const ignoredDirectories = new Set([
		'node_modules',
		'.git',
		'dist',
		'build',
		'coverage'
	]);

	async function collectJavaScriptFiles(
		directory: string
	): Promise<string[]> {
		const files: string[] = [];

		let entries;

		try {
			entries = await fs.readdir(directory, {
				withFileTypes: true
			});
		} catch {
			return files;
		}

		for (const entry of entries) {
			const fullPath = path.join(directory, entry.name);

			if (entry.isDirectory()) {
				if (ignoredDirectories.has(entry.name)) {
					continue;
				}

				files.push(
					...await collectJavaScriptFiles(fullPath)
				);
			} else if (
				entry.isFile() &&
				entry.name.endsWith('.js')
			) {
				files.push(fullPath);
			}
		}

		return files;
	}

	const root = path.resolve(projectFolder.fsPath);
	const files = await collectJavaScriptFiles(root);

	const escapedId = elementId.replace(
		/[.*+?^${}()|[\]\\]/g,
		'\\$&'
	);

	const lookupPattern = new RegExp(
		String.raw`getElementById\s*\(\s*(['"])${escapedId}\1\s*\)`
	);

	for (const filePath of files) {
		const relativePath = path.relative(root, filePath);

		if (
			relativePath.startsWith('..') ||
			path.isAbsolute(relativePath)
		) {
			continue;
		}

		let source: string;

		try {
			source = await fs.readFile(filePath, 'utf8');
		} catch {
			continue;
		}

		const lines = source.split(/\r?\n/);
		const lookupLine = lines.findIndex(
			line => lookupPattern.test(line)
		);

		if (lookupLine === -1) {
			continue;
		}

		const variableMatch = lines[lookupLine].match(
			/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/
		);

		if (!variableMatch) {
			continue;
		}

		const variableName = variableMatch[1];
		const escapedVariable = variableName.replace(
			/[.*+?^${}()|[\]\\]/g,
			'\\$&'
		);

		const listenerPattern = new RegExp(
			String.raw`\b${escapedVariable}\s*\.\s*addEventListener\s*\(`
		);

		const listenerLine = lines.findIndex(
			(line, index) =>
				index > lookupLine && listenerPattern.test(line)
		);

		if (listenerLine === -1) {
			continue;
		}

		return {
			uri: vscode.Uri.file(filePath),
			line: listenerLine + 1,
			description: 'Click event listener'
		};
	}

	return undefined;
}
function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function getNonce(): string {
	const characters =
		'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

	let nonce = '';

	for (let i = 0; i < 32; i++) {
		nonce += characters.charAt(
			Math.floor(Math.random() * characters.length)
		);
	}

	return nonce;
}

export function deactivate() { }
