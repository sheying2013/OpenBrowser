'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'ui', 'ui-dialogs.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

assert.ok(index.includes('id="app-confirm-dialog"'), 'confirm dialog is part of the app shell');
assert.ok(index.includes('src="ui/ui-dialogs.js"'), 'confirm dialog controller is loaded');
const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
assert.ok(!/\bconfirm\s*\(/.test(codeOnly), 'confirmation UI never falls back to the native dialog');
assert.ok(!/\.innerHTML\s*=/.test(source), 'confirmation UI is built without HTML string injection');
assert.ok(source.includes('document.activeElement'), 'confirmation UI captures its trigger for focus restoration');
assert.ok(source.includes('triggerEl.focus'), 'confirmation UI restores focus after closing');
assert.ok(source.includes("e.key === 'Escape'"), 'confirmation UI supports Escape to cancel');
assert.ok(source.includes('removeEventListener'), 'confirmation UI cleans up one-shot listeners');
assert.ok(source.includes('options.confirmLabel'), 'confirmation UI supports the shared confirmLabel contract');

console.log('ui-dialogs-selftest: OK');
