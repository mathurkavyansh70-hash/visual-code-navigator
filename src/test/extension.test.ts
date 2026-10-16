import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { buildPreviewHtml, findCssSource } from '../extension';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('resolves relative CSS URLs and locates grouped selectors in nested rules', async () => {
		const projectPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'visual-code-navigator-')
		);

		try {
			const cssPath = path.join(projectPath, 'styles', 'site.css');
			await fs.mkdir(path.dirname(cssPath), { recursive: true });
			await fs.writeFile(
				cssPath,
				'@media (min-width: 1px) {\n' +
				'  .hero,\n' +
				'  .primary-button {\n' +
				'    color: red;\n' +
				'  }\n' +
				'}\n',
				'utf8'
			);

			const projectFolder = vscode.Uri.file(projectPath);
			const reportDiagnostic = (message: string) => {
				assert.fail(`Unexpected CSS diagnostic: ${message}`);
			};

			const hero = await findCssSource(
				projectFolder,
				'vscode-webview://example/project/',
				'styles/site.css',
				'.hero',
				reportDiagnostic
			);
			const primaryButton = await findCssSource(
				projectFolder,
				'vscode-webview://example/project/',
				'styles/site.css',
				'.primary-button',
				reportDiagnostic
			);
			const absoluteHref = await findCssSource(
				projectFolder,
				'vscode-webview://example/project/',
				'vscode-webview://example/project/styles/site.css?version=1',
				'.primary-button',
				reportDiagnostic
			);
			const rootRelativeHref = await findCssSource(
				projectFolder,
				'vscode-webview://example/project/',
				'/styles/site.css',
				'.hero',
				reportDiagnostic
			);

			assert.strictEqual(
				path.relative(cssPath, hero?.uri.fsPath ?? ''),
				''
			);
			assert.strictEqual(hero?.line, 2);
			assert.strictEqual(
				path.relative(cssPath, primaryButton?.uri.fsPath ?? ''),
				''
			);
			assert.strictEqual(primaryButton?.line, 3);
			assert.strictEqual(absoluteHref?.line, 3);
			assert.strictEqual(rootRelativeHref?.line, 2);
		} finally {
			await fs.rm(projectPath, { recursive: true, force: true });
		}
	});

	test('sends CSS candidates for comma-separated and nested rules', () => {
		const panel = vscode.window.createWebviewPanel(
			'visualCodeNavigatorTest',
			'Visual Code Navigator Test',
			vscode.ViewColumn.Beside,
			{ enableScripts: true }
		);

		try {
			const html = buildPreviewHtml(
				panel.webview,
				'<html><head></head><body></body></html>',
				'vscode-webview://example/project/'
			);
			const script = html.match(
				/<script nonce="[^"]*">([\s\S]*?)<\/script>/
			);

			assert.ok(script);

			class MockLink {
				readonly nodeName = 'LINK';

				getAttribute(name: string): string | null {
					return name === 'href' ? 'styles/site.css' : null;
				}
			}

			class MockElement {
				readonly tagName = 'DIV';
				readonly id = '';
				readonly innerText = 'sample';
				readonly textContent = 'sample';
				readonly classList = {
					add: (_className: string) => undefined,
					remove: (_className: string) => undefined
				};

				constructor(
					readonly className: string,
					private readonly matchedSelectors: Set<string>
				) { }

				closest(selector: string) {
					if (selector === '[data-vcn-source-line]') {
						return { getAttribute: () => '12' };
					}
					return null;
				}

				matches(selector: string): boolean {
					return this.matchedSelectors.has(selector);
				}
			}

			let clickHandler:
				| ((event: { target: MockElement }) => void)
				| undefined;
			const sentMessages: Array<Record<string, unknown>> = [];
			const inspector = {
				replaceChildren: () => undefined,
				append: (..._nodes: unknown[]) => undefined
			};
			const stylesheet = {
				ownerNode: new MockLink(),
				href: 'vscode-webview://example/project/styles/site.css',
				cssRules: [
					{
						selectorText: '.hero, .primary-button',
						style: {},
						cssRules: []
					},
					{
						cssRules: [
							{
								selectorText: '.feature-card',
								style: {},
								cssRules: []
							}
						]
					}
				]
			};
			const documentMock = {
				styleSheets: [stylesheet],
				getElementById: () => inspector,
				addEventListener: (
					_type: string,
					listener: (event: { target: MockElement }) => void
				) => {
					clickHandler = listener;
				},
				createElement: () => ({ textContent: '' })
			};

			new vm.Script(script[1]).runInNewContext({
				acquireVsCodeApi: () => ({
					postMessage: (message: Record<string, unknown>) =>
						sentMessages.push(message)
				}),
				document: documentMock,
				Element: MockElement,
				HTMLLinkElement: MockLink,
				CSSImportRule: class { },
				console: { log: () => undefined, warn: () => undefined }
			});
			assert.ok(clickHandler);

			for (const selector of [
				'.hero',
				'.primary-button',
				'.feature-card'
			]) {
				const element = new MockElement(
					selector.slice(1),
					new Set([selector])
				);
				clickHandler({ target: element });
			}

			assert.strictEqual(
				JSON.stringify(sentMessages
					.filter(message => message.command === 'elementSelected')
					.map(message =>
						(message.cssCandidates as Array<{ selector: string }>)
							.map(candidate => candidate.selector)
					)),
				JSON.stringify([
					['.hero'],
					['.primary-button'],
					['.feature-card']
				])
			);
			assert.strictEqual(
				(sentMessages.find(message =>
					message.command === 'elementSelected'
				)?.cssCandidates as Array<{ href: string }>)[0].href,
				stylesheet.href
			);
		} finally {
			panel.dispose();
		}
	});
});
