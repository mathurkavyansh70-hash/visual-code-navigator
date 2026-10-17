
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

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
			const indexFile = vscode.Uri.joinPath(
				projectFolder,
				'index.html'
			);

			try {
				await fs.access(indexFile.fsPath);
			} catch {
				vscode.window.showErrorMessage(
					'No index.html found in the selected folder.'
				);
				return;
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

			const baseUri = panel.webview.asWebviewUri(
				vscode.Uri.file(projectFolder.fsPath + path.sep)
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
									description: `index.html:${sourceLine}`,
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
								baseUri.toString(),
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

	context.subscriptions.push(
		helloCommand,
		openProjectCommand
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
