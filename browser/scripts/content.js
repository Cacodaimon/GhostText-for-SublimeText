/* global GThumane */

const knownElements = new Map();
const activeFields = new Set();

let isWaitingForActivation = false;

class ContentEditableWrapper {
	constructor(element) {
		this.el = element;
		this.dataset = element.dataset;
		this.addEventListener = element.addEventListener.bind(element);
		this.removeEventListener = element.removeEventListener.bind(element);
		this.blur = element.blur.bind(element);
	}

	get value() {
		return this.el.innerHTML;
	}

	set value(html) {
		this.el.innerHTML = html;
	}
}

class AdvancedTextWrapper {
	constructor(element, visualElement) {
		this.el = element;
		this.dataset = visualElement.dataset;
		this.el.addEventListener('gt:input', event => {
			this._value = event.detail.value;
		});
		this.el.dispatchEvent(
			new CustomEvent('gt:get', {
				bubbles: true
			})
		);
	}

	blur() {
		this.el.dispatchEvent(new CustomEvent('gt:blur'));
	}

	addEventListener(type, callback) {
		this.el.addEventListener(`gt:${type}`, callback);
	}

	removeEventListener(type, callback) {
		this.el.removeEventListener(`gt:${type}`, callback);
	}

	get value() {
		return this._value;
	}

	set value(value) {
		if (this._value !== value) {
			this._value = value;
			this.el.setAttribute('gt-value', value);
			this.el.dispatchEvent(new CustomEvent('gt:transfer'));
		}
	}
}

function wrapField(field) {
	if (field.classList.contains('ace_text-input')) {
		const ace = field.parentNode;
		const visualElement = ace.querySelector('.ace_scroller');
		return new AdvancedTextWrapper(ace, visualElement);
	}

	const cm = field.closest('.CodeMirror');
	if (cm) {
		const visualElement = cm.querySelector('.CodeMirror-sizer');
		return new AdvancedTextWrapper(cm, visualElement);
	}

	if (field.isContentEditable) {
		return new ContentEditableWrapper(field);
	}

	return field;
}

class GhostTextField {
	constructor(field) {
		this.field = wrapField(field);
		this.field.dataset.gtField = '';
		this.send = this.send.bind(this);
		this.receive = this.receive.bind(this);
		this.deactivate = this.deactivate.bind(this);
		this.tryFocus = this.tryFocus.bind(this);
		field.addEventListener('focus', this.tryFocus);
		this.state = 'inactive';
	}

	async activate() {
		if (this.state === 'active') {
			return;
		}

		this.state = 'active';
		activeFields.add(this);

		this.field.dataset.gtField = 'loading';

		this.port = chrome.runtime.connect({name: 'new-field'});
		this.port.onMessage.addListener(message => {
			if (message.message) {
				this.receive({data: message.message});
			} else if (message.close) {
				this.deactivate(false);
				updateCount();
			} else if (message.ready) {
				notify('log', 'Connected! You can switch to your editor');

				this.field.addEventListener('input', this.send);
				this.field.dataset.gtField = 'enabled';

				// Send first value to init tab
				this.send();
				updateCount();
			} else if (message.error) {
				notify('warn', message.error);
				this.deactivate(false);
			}
		});
	}

	send(event) {
		if (event && event.detail?.ghostTextSyntheticEvent) {
			return;
		}

		console.info('sending', this.field.value.length, 'characters');
		this.port.postMessage(
			JSON.stringify({
				title: document.title, // TODO: move to first fetch
				url: location.host, // TODO: move to first fetch
				syntax: '', // TODO: move to first fetch
				text: this.field.value,
				selections: [
					{
						start: this.field.selectionStart || 0,
						end: this.field.selectionEnd || 0
					}
				]
			})
		);
	}

	receive(event) {
		const {text, selections} = JSON.parse(event.data);

		if (this.field.value !== text) {
			this.field.value = text;

			if (this.field.dispatchEvent) {
				// These are in the right order
				this.field.dispatchEvent(new KeyboardEvent('keydown'));
				this.field.dispatchEvent(new KeyboardEvent('keypress'));
				this.field.dispatchEvent(new CompositionEvent('textInput'));
				this.field.dispatchEvent(new CustomEvent('input', { // InputEvent doesn't support custom data
					detail: {
						ghostTextSyntheticEvent: true
					}
				}));
				this.field.dispatchEvent(new KeyboardEvent('keyup'));
			}
		}

		this.field.selectionStart = selections[0].start;
		this.field.selectionEnd = selections[0].end;
	}

	deactivate(wasSuccessful = true) {
		if (this.state === 'inactive') {
			return;
		}

		this.state = 'inactive';
		console.log('Disabling field');
		activeFields.delete(this);
		this.port.disconnect();
		this.field.removeEventListener('input', this.send);
		this.field.dataset.gtField = '';
		if (wasSuccessful) {
			updateCount();
		}
	}

	tryFocus() {
		if (isWaitingForActivation && this.state === 'inactive') {
			this.activate();
			isWaitingForActivation = false;
			document.body.classList.remove('GT--waiting');
		}
	}

	static deactivateAll() {
		for (const field of activeFields) {
			field.deactivate();
		}
	}
}

function updateCount() {
	chrome.runtime.sendMessage({
		code: 'connection-count',
		count: activeFields.size
	});

	if (activeFields.size === 0) {
		notify('log', 'Disconnected! \n <a href="https://github.com/GhostText/GhostText/issues" target="_blank">Report issues</a>');
	}
}

const selector = `
	textarea,
	[contenteditable=""],
	[contenteditable="true"]
`;
function registerElements() {
	for (const element of document.querySelectorAll(selector)) {
		// TODO: Only handle areas that are visible
		//  && element.getBoundingClientRect().width > 20
		if (!knownElements.has(element)) {
			knownElements.set(element, new GhostTextField(element));
		}
	}
}

function getMessageDisplayTime(message) {
	const wpm = 100; // 180 is the average words read per minute, make it slower
	return message.split(' ').length / wpm * 60000;
}

function notify(type, message, stay) {
	console[type]('GhostText:', message);
	GThumane.remove();
	message = message.replace(/\n/g, '<br>');
	const timeout = stay ? 0 : getMessageDisplayTime(message);
	GThumane.log(message, {
		timeout,
		clickToClose: true,
		addnCls: type === 'log' ? '' : 'ghost-text-message-error'
	});
}

function startGT() {
	registerElements();
	console.info(knownElements.size + ' elements on the page');
	if (knownElements.size === 0) {
		notify('warn', 'No supported elements found!');
		return;
	}

	// Blur focused element to allow selection with a click/focus
	const focused = knownElements.get(document.activeElement);
	if (focused) {
		focused.field.blur();
	}

	// If there's one element and it's not active, activate.
	// If it's one and active, do nothing
	if (knownElements.size === 1) {
		if (activeFields.size === 0) {
			const [field] = knownElements.values();
			field.activate();
		}
	} else {
		isWaitingForActivation = true;
		document.body.classList.add('GT--waiting');

		if (activeFields.size === 0) {
			notify('log', 'Click on the desired element to activate it.', true);
		} else {
			notify('log', 'Click on the desired element to activate it or right-click the GhostText icon to stop the connection.', true);
		}
		// TODO: waiting timeout
	}
}

function stopGT() {
	GhostTextField.deactivateAll();
	isWaitingForActivation = false;
	document.body.classList.remove('GT--waiting');
}

function init() {
	const script = document.createElement('script');
	script.textContent = '(' + window.unsafeMessenger.toString() + ')()';
	document.head.append(script);
}

window.startGT = startGT;
window.stopGT = stopGT;

init();
