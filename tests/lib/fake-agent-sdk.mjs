// A controlled SDK boundary for provider callback tests. No CLI or network calls.
const calls = [];
const waiters = [];
export function nextCall() {
	if (calls.length) return Promise.resolve(calls.shift());
	return new Promise((resolve) => waiters.push(resolve));
}
export function query(input) {
	let wake;
	const messages = [];
	let finished = false;
	const call = {
		input,
		interrupts: 0,
		closes: 0,
		emit(message) { messages.push(message); wake?.(); wake = undefined; },
		finish() { finished = true; wake?.(); wake = undefined; },
		async interrupt() { call.interrupts++; },
		close() { call.closes++; },
		async *[Symbol.asyncIterator]() {
			while (true) {
				if (messages.length) { yield messages.shift(); continue; }
				if (finished) return;
				await new Promise((resolve) => { wake = resolve; });
			}
		},
	};
	const waiter = waiters.shift();
	if (waiter) waiter(call);
	else calls.push(call);
	return call;
}
