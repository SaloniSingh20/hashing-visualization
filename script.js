(function () {
  const TOMBSTONE = Symbol('tombstone');

  const strategyLabels = {
    separateChaining: 'Separate Chaining',
    linearProbing: 'Linear Probing',
    quadraticProbing: 'Quadratic Probing',
    doubleHashing: 'Double Hashing',
  };

  const MIN_TABLE_SIZE = 3;
  const MAX_TABLE_SIZE = 199;

  function clampTableSize(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return MIN_TABLE_SIZE;
    return Math.min(Math.max(Math.floor(numeric), MIN_TABLE_SIZE), MAX_TABLE_SIZE);
  }

  function isPrime(n) {
    if (n <= 1) return false;
    if (n <= 3) return true;
    if (n % 2 === 0 || n % 3 === 0) return false;
    for (let i = 5; i * i <= n; i += 6) {
      if (n % i === 0 || n % (i + 2) === 0) return false;
    }
    return true;
  }

  function nextPrime(n) {
    let candidate = Math.max(2, Math.floor(n));
    while (!isPrime(candidate)) {
      candidate += 1;
    }
    return candidate;
  }

  function nearestLowerPrime(n) {
    for (let candidate = n - 1; candidate >= 2; candidate -= 1) {
      if (isPrime(candidate)) return candidate;
    }
    return 1;
  }

  function normaliseSizeForStrategy(size, strategyName) {
    const clamped = clampTableSize(size);
    if (strategyName === 'doubleHashing') {
      return nextPrime(clamped);
    }
    return clamped;
  }

  class BaseStrategy {
    constructor(size) {
      this.size = size;
    }

    normaliseKey(rawKey) {
      return String(rawKey).trim();
    }

    numericValue(key) {
      const numeric = Number(key);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
      let acc = 0;
      for (let i = 0; i < key.length; i += 1) {
        acc = (acc * 31 + key.charCodeAt(i)) >>> 0;
      }
      return acc;
    }

    hashFromKey(key) {
      const numeric = this.numericValue(key);
      return Math.abs(numeric) >>> 0;
    }

    primaryIndexFromKey(key) {
      if (this.size === 0) return 0;
      const hash = this.hashFromKey(key);
      const mod = hash % this.size;
      return (mod + this.size) % this.size;
    }

    resize(newSize) {
      this.size = newSize;
    }
  }

  class SeparateChainingStrategy extends BaseStrategy {
    constructor(size) {
      super(size);
      this.clear();
    }

    clear() {
      this.table = Array.from({ length: this.size }, () => []);
      this.count = 0;
    }

    insert(rawKey) {
      const key = this.normaliseKey(rawKey);
      const logs = [];
      const highlights = [];
      const index = this.primaryIndexFromKey(key);
      const bucket = this.table[index];

      logs.push(`hash("${key}") = ${index}`);
      highlights.push({ index, type: 'probe' });

      const exists = bucket.find((entry) => entry.key === key);
      if (exists) {
        logs.push(`Key "${key}" already exists in bucket ${index}.`);
        highlights.push({ index, type: 'found' });
        return { logs, highlights, status: 'duplicate' };
      }

      bucket.push({ key, value: key });
      this.count += 1;
      logs.push(`Inserted "${key}" into bucket ${index}.`);
      highlights.push({ index, type: 'placed' });
      return { logs, highlights, status: 'inserted' };
    }

    search(rawKey) {
      const key = this.normaliseKey(rawKey);
      const logs = [];
      const highlights = [];
      const index = this.primaryIndexFromKey(key);
      const bucket = this.table[index];

      logs.push(`hash("${key}") = ${index}`);
      highlights.push({ index, type: 'probe' });

      const position = bucket.findIndex((entry) => entry.key === key);
      if (position === -1) {
        logs.push(`Bucket ${index} scanned. "${key}" is not present.`);
        return { logs, highlights, status: 'missing' };
      }

      logs.push(`Found "${key}" at bucket ${index}, position ${position}.`);
      highlights.push({ index, type: 'found' });
      return { logs, highlights, status: 'found' };
    }

    remove(rawKey) {
      const key = this.normaliseKey(rawKey);
      const logs = [];
      const highlights = [];
      const index = this.primaryIndexFromKey(key);
      const bucket = this.table[index];

      logs.push(`hash("${key}") = ${index}`);
      highlights.push({ index, type: 'probe' });

      const position = bucket.findIndex((entry) => entry.key === key);
      if (position === -1) {
        logs.push(`Nothing to delete. "${key}" does not live in bucket ${index}.`);
        return { logs, highlights, status: 'missing' };
      }

      bucket.splice(position, 1);
      this.count = Math.max(this.count - 1, 0);
      logs.push(`Removed "${key}" from bucket ${index}.`);
      highlights.push({ index, type: 'placed' });
      return { logs, highlights, status: 'removed' };
    }

    snapshot() {
      return this.table.map((bucket, index) => ({
        index,
        state: bucket.length === 0 ? 'emptyChain' : 'chain',
        items: bucket.map((entry) => ({ kind: 'value', label: entry.key })),
      }));
    }
  }

  class OpenAddressingStrategy extends BaseStrategy {
    constructor(size) {
      super(size);
      this.clear();
    }

    clear() {
      this.table = Array.from({ length: this.size }, () => null);
      this.count = 0;
    }

    createProbeContext(key, baseIndex, logs) {
      return { base: baseIndex };
    }

    probeIndex(context, attempt) {
      const index = (context.base + attempt) % this.size;
      return { index, note: `Probe ${attempt + 1}: slot ${index}` };
    }

    insert(rawKey) {
      const key = this.normaliseKey(rawKey);
      const logs = [];
      const highlights = [];
      const base = this.primaryIndexFromKey(key);
      logs.push(`hash("${key}") = ${base}`);
      const context = this.createProbeContext(key, base, logs);
      let firstTombstone = -1;

      for (let attempt = 0; attempt < this.size; attempt += 1) {
        const { index, note } = this.probeIndex(context, attempt, key);
        if (note) logs.push(note);
        highlights.push({ index, type: 'probe' });
        const entry = this.table[index];

        if (entry && entry !== TOMBSTONE && entry.key === key) {
          logs.push(`Key "${key}" already stored at slot ${index}.`);
          highlights.push({ index, type: 'found' });
          return { logs, highlights, status: 'duplicate' };
        }

        if (entry === null) {
          const target = firstTombstone !== -1 ? firstTombstone : index;
          this.table[target] = { key, value: key };
          this.count += 1;
          if (target === index) {
            logs.push(`Placed "${key}" at slot ${target}.`);
          } else {
            logs.push(`Reused tombstone at slot ${target} for "${key}".`);
          }
          highlights.push({ index: target, type: 'placed' });
          return { logs, highlights, status: 'inserted' };
        }

        if (entry === TOMBSTONE && firstTombstone === -1) {
          firstTombstone = index;
        }
      }

      if (firstTombstone !== -1) {
        this.table[firstTombstone] = { key, value: key };
        this.count += 1;
        logs.push(`Probe wrapped. Inserted "${key}" into tombstone slot ${firstTombstone}.`);
        highlights.push({ index: firstTombstone, type: 'placed' });
        return { logs, highlights, status: 'inserted' };
      }

      logs.push('Table is full. Could not insert the key.');
      return { logs, highlights, status: 'full' };
    }

    search(rawKey) {
      const key = this.normaliseKey(rawKey);
      const logs = [];
      const highlights = [];
      const base = this.primaryIndexFromKey(key);
      logs.push(`hash("${key}") = ${base}`);
      const context = this.createProbeContext(key, base, logs);

      for (let attempt = 0; attempt < this.size; attempt += 1) {
        const { index, note } = this.probeIndex(context, attempt, key);
        if (note) logs.push(note);
        highlights.push({ index, type: 'probe' });
        const entry = this.table[index];
        if (entry && entry !== TOMBSTONE && entry.key === key) {
          logs.push(`Success! "${key}" found at slot ${index}.`);
          highlights.push({ index, type: 'found' });
          return { logs, highlights, status: 'found' };
        }
        if (entry === null) {
          logs.push('Encountered an empty slot. Key is not present.');
          return { logs, highlights, status: 'missing' };
        }
      }

      logs.push('Scanned every slot. Key not located.');
      return { logs, highlights, status: 'missing' };
    }

    remove(rawKey) {
      const key = this.normaliseKey(rawKey);
      const logs = [];
      const highlights = [];
      const base = this.primaryIndexFromKey(key);
      logs.push(`hash("${key}") = ${base}`);
      const context = this.createProbeContext(key, base, logs);

      for (let attempt = 0; attempt < this.size; attempt += 1) {
        const { index, note } = this.probeIndex(context, attempt, key);
        if (note) logs.push(note);
        highlights.push({ index, type: 'probe' });
        const entry = this.table[index];
        if (entry && entry !== TOMBSTONE && entry.key === key) {
          this.table[index] = TOMBSTONE;
          this.count = Math.max(this.count - 1, 0);
          logs.push(`Marked slot ${index} as tombstone.`);
          highlights.push({ index, type: 'placed' });
          return { logs, highlights, status: 'removed' };
        }
        if (entry === null) {
          logs.push('Reached an empty slot before finding the key. Nothing removed.');
          return { logs, highlights, status: 'missing' };
        }
      }

      logs.push('Full scan complete. Key was not found.');
      return { logs, highlights, status: 'missing' };
    }

    snapshot() {
      return this.table.map((entry, index) => {
        if (entry === null) {
          return { index, state: 'empty', items: [] };
        }
        if (entry === TOMBSTONE) {
          return { index, state: 'tombstone', items: [] };
        }
        return {
          index,
          state: 'value',
          items: [{ kind: 'value', label: entry.key }],
        };
      });
    }
  }

  class LinearProbingStrategy extends OpenAddressingStrategy {}

  class QuadraticProbingStrategy extends OpenAddressingStrategy {
    probeIndex(context, attempt) {
      const offset = attempt * attempt;
      const index = (context.base + offset) % this.size;
      const note = attempt === 0
        ? `Probe 1: slot ${index}`
        : `Probe ${attempt + 1}: +${offset} ⇒ slot ${index}`;
      return { index, note };
    }
  }

  class DoubleHashingStrategy extends OpenAddressingStrategy {
    createProbeContext(key, base, logs) {
      const step = this.secondaryStepFromKey(key);
      logs.push(`step("${key}") = ${step}`);
      return { base, step };
    }

    secondaryStepFromKey(key) {
      if (this.size <= 1) return 1;
      const numeric = this.numericValue(key);
      const modBase = this.size - 1 || 1;
      const step = 1 + Math.abs(numeric % modBase);
      return step % this.size === 0 ? 1 : step;
    }

    probeIndex(context, attempt) {
      const index = (context.base + attempt * context.step) % this.size;
      const note = `Probe ${attempt + 1}: ${context.base} + ${attempt}×${context.step} ⇒ slot ${index}`;
      return { index, note };
    }
  }

  const strategyFactories = {
    separateChaining: (size) => new SeparateChainingStrategy(size),
    linearProbing: (size) => new LinearProbingStrategy(size),
    quadraticProbing: (size) => new QuadraticProbingStrategy(size),
    doubleHashing: (size) => new DoubleHashingStrategy(size),
  };

  class HashingController {
    constructor() {
      this.sizeInput = document.getElementById('tableSize');
      this.strategySelect = document.getElementById('strategy');
      this.keyInput = document.getElementById('keyInput');
      this.tableElement = document.getElementById('hashTable');
      this.logElement = document.getElementById('log');
      this.template = document.getElementById('bucketTemplate');
      this.animationTimers = [];

      this.strategyName = this.strategySelect.value;
      this.tableSize = normaliseSizeForStrategy(
        Number(this.sizeInput.value) || 11,
        this.strategyName
      );
      this.sizeInput.value = this.tableSize;
      this.strategy = strategyFactories[this.strategyName](this.tableSize);

      this.attachEvents();
      this.render();
      this.writeLog([
        `Ready! Using ${strategyLabels[this.strategyName]} with table size ${this.tableSize}.`,
      ]);
    }

    attachEvents() {
      document.getElementById('insertBtn').addEventListener('click', () =>
        this.handleAction('insert')
      );
      document.getElementById('searchBtn').addEventListener('click', () =>
        this.handleAction('search')
      );
      document.getElementById('deleteBtn').addEventListener('click', () =>
        this.handleAction('remove')
      );
      document.getElementById('resetBtn').addEventListener('click', () => {
        this.resetTable();
        this.writeLog([
          `Cleared the table. Still using ${strategyLabels[this.strategyName]} with size ${this.tableSize}.`,
        ]);
      });

      this.strategySelect.addEventListener('change', () => {
        this.strategyName = this.strategySelect.value;
        this.tableSize = normaliseSizeForStrategy(
          Number(this.sizeInput.value) || this.tableSize,
          this.strategyName
        );
        this.sizeInput.value = this.tableSize;
        this.resetTable(false);
        this.writeLog([
          `Switched to ${strategyLabels[this.strategyName]}. Table refreshed at size ${this.tableSize}.`,
        ]);
      });

      this.sizeInput.addEventListener('change', () => {
        const parsed = normaliseSizeForStrategy(
          Number(this.sizeInput.value) || this.tableSize,
          this.strategyName
        );
        this.tableSize = parsed;
        this.sizeInput.value = parsed;
        this.resetTable(false);
        this.writeLog([
          `Changed table size to ${parsed}. Starting fresh with ${strategyLabels[this.strategyName]}.`,
        ]);
      });

      this.keyInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          this.handleAction('insert');
        }
      });
    }

    resetTable(renderLog = true) {
      this.strategy = strategyFactories[this.strategyName](this.tableSize);
      this.render();
      if (!renderLog) return;
      this.writeLog([
        `Table reset. Ready with ${strategyLabels[this.strategyName]} (${this.tableSize} slots).`,
      ]);
    }

    handleAction(action) {
      const rawKey = this.keyInput.value.trim();
      if (!rawKey) {
        this.writeLog(['Enter a key (text or number) to run the operation.']);
        this.keyInput.focus();
        return;
      }

      let result;
      switch (action) {
        case 'insert':
          result = this.strategy.insert(rawKey);
          break;
        case 'search':
          result = this.strategy.search(rawKey);
          break;
        case 'remove':
          result = this.strategy.remove(rawKey);
          break;
        default:
          result = { logs: ['Unknown action.'], highlights: [] };
      }

      const highlights = result?.highlights || [];
      this.render(highlights);
      this.playAnimation(highlights);
      if (result?.logs?.length) {
        this.writeLog(result.logs);
      }
    }

    render(highlights = []) {
      this.tableSize = this.strategy.size;
      if (Number(this.sizeInput.value) !== this.tableSize) {
        this.sizeInput.value = this.tableSize;
      }

      this.clearAnimations();

      const fragment = document.createDocumentFragment();
      const snapshot = this.strategy.snapshot();
      const highlightMap = new Map();

      highlights.forEach(({ index, type }) => {
        if (!highlightMap.has(index)) {
          highlightMap.set(index, { accent: false });
        }
        if (type === 'placed' || type === 'found') {
          const record = highlightMap.get(index);
          record.accent = true;
        }
      });

      snapshot.forEach((bucket) => {
        const clone = this.template.content.firstElementChild.cloneNode(true);
        const indexEl = clone.querySelector('.index');
        const slotEl = clone.querySelector('.slot');
        indexEl.textContent = bucket.index;
        clone.dataset.index = String(bucket.index);

        const highlight = highlightMap.get(bucket.index);
        if (highlight?.accent) {
          clone.classList.add('final-highlight');
        }

        if (bucket.items.length === 0) {
          const placeholder = document.createElement('div');
          placeholder.className = 'item';
          let placeholderState = 'empty';
          if (bucket.state === 'tombstone') placeholderState = 'tombstone';
          if (bucket.state === 'emptyChain') placeholderState = 'empty';
          placeholder.dataset.state = placeholderState;
          placeholder.textContent = this.placeholderLabel(bucket.state);
          slotEl.appendChild(placeholder);
        } else {
          bucket.items.forEach((item) => {
            const chip = document.createElement('div');
            chip.className = 'item';
            chip.dataset.state = item.kind || 'value';
            const keySpan = document.createElement('span');
            keySpan.className = 'key';
            keySpan.textContent = item.label;
            chip.appendChild(keySpan);
            slotEl.appendChild(chip);
          });
        }

        fragment.appendChild(clone);
      });

      this.tableElement.innerHTML = '';
      this.tableElement.appendChild(fragment);
    }

    placeholderLabel(state) {
      switch (state) {
        case 'tombstone':
          return 'tombstone';
        case 'emptyChain':
          return 'empty chain';
        case 'chain':
          return 'chain';
        default:
          return 'empty';
      }
    }

    clearAnimations() {
      this.animationTimers.forEach((timer) => clearTimeout(timer));
      this.animationTimers = [];
      if (!this.tableElement) return;
      this.tableElement
        .querySelectorAll('.bucket')
        .forEach((bucket) => bucket.classList.remove('animate-probe', 'animate-hit'));
    }

    playAnimation(highlights = []) {
      if (!Array.isArray(highlights) || highlights.length === 0) {
        return;
      }

      this.clearAnimations();

      highlights.forEach((entry, order) => {
        const bucketEl = this.tableElement.querySelector(
          `.bucket[data-index="${entry.index}"]`
        );
        if (!bucketEl) return;
        const delay = order * 320;
        const timer = setTimeout(() => {
          const className =
            entry.type === 'placed' || entry.type === 'found'
              ? 'animate-hit'
              : 'animate-probe';
          bucketEl.classList.add(className);
          bucketEl.addEventListener(
            'animationend',
            () => {
              bucketEl.classList.remove(className);
            },
            { once: true }
          );
        }, delay);
        this.animationTimers.push(timer);
      });
    }

    writeLog(messages) {
      this.logElement.innerHTML = '';
      messages.forEach((message) => {
        const item = document.createElement('li');
        item.textContent = message;
        this.logElement.appendChild(item);
      });
      this.logElement.scrollTop = this.logElement.scrollHeight;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    new HashingController();
  });
})();
(function () {
  const TOMBSTONE = Symbol('tombstone');

  const strategyLabels = {
    separateChaining: 'Separate Chaining',
    linearProbing: 'Linear Probing',
    quadraticProbing: 'Quadratic Probing',
    doubleHashing: 'Double Hashing',
  };

  const strategyMetadata = {
    separateChaining: { mode: 'chaining' },
    linearProbing: { mode: 'open' },
    quadraticProbing: { mode: 'open' },
    doubleHashing: { mode: 'open' },
  };

  const MIN_TABLE_SIZE = 3;
  const MAX_TABLE_SIZE = 199;

  function clampTableSize(value) {
    const numeric = Number.isFinite(Number(value)) ? Number(value) : MIN_TABLE_SIZE;
    return Math.min(Math.max(Math.floor(numeric), MIN_TABLE_SIZE), MAX_TABLE_SIZE);
  }

  function isPrime(value) {
    const n = Math.floor(value);
    if (n <= 1) return false;
    if (n <= 3) return true;
    if (n % 2 === 0 || n % 3 === 0) return false;
    for (let i = 5; i * i <= n; i += 6) {
      if (n % i === 0 || n % (i + 2) === 0) return false;
    }
    return true;
  }

  function nextPrime(value) {
    let candidate = clampTableSize(value);
    if (candidate % 2 === 0) candidate += 1;
    while (candidate <= MAX_TABLE_SIZE) {
      if (isPrime(candidate)) return candidate;
      candidate += 2;
    }
    return MAX_TABLE_SIZE;
  }

  function previousPrime(value) {
    let candidate = clampTableSize(value);
    if (candidate <= MIN_TABLE_SIZE) return MIN_TABLE_SIZE;
    if (candidate % 2 === 0) candidate -= 1;
    while (candidate >= MIN_TABLE_SIZE) {
      if (isPrime(candidate)) return candidate;
      candidate -= 2;
    }
    return MIN_TABLE_SIZE;
  }

  function normaliseSizeForStrategy(size, strategyName) {
    const metadata = strategyMetadata[strategyName];
    const clamped = clampTableSize(size);
    if (metadata?.mode === 'open') {
      return nextPrime(clamped);
    }
    return clamped;
  }

  class BaseStrategy {
    constructor(size) {
      this.size = size;
    }

    normaliseKey(rawKey) {
      if (typeof rawKey === 'number') {
        return String(rawKey);
      }
      const key = String(rawKey).trim();
      if (/^-?\d+$/.test(key)) {
        return String(parseInt(key, 10));
      }
      return key;
    }

    hashCode(rawKey) {
      const key = this.normaliseKey(rawKey);
      let hash = 0x811c9dc5;
      for (let i = 0; i < key.length; i += 1) {
        hash ^= key.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
      }
      return hash >>> 0;
    }

    primaryIndex(rawKey) {
      return this.hashCode(rawKey) % this.size;
    }

    secondaryStep(rawKey) {
      if (this.size <= 1) return 1;
      const hash = this.hashCode(rawKey);
      const step = 1 + (hash % (this.size - 1 || 1));
      return step === 0 ? 1 : step;
    }

    resize(newSize) {
      this.size = newSize;
    }

    stats() {
      return { size: this.size, keys: 0, loadFactor: 0, kind: 'base' };
    }
  }

  class SeparateChainingStrategy extends BaseStrategy {
    constructor(size) {
      super(size);
      this.clear();
    }

    clear() {
      this.table = Array.from({ length: this.size }, () => []);
      this.count = 0;
    }

    insertInternal(key) {
      const index = this.primaryIndex(key);
      this.table[index].push(key);
      this.count += 1;
    }

    rehash(newSize, message) {
      const logs = [];
      const entries = this.table.flat();
      this.size = newSize;
      this.table = Array.from({ length: newSize }, () => []);
      this.count = 0;
      entries.forEach((entry) => this.insertInternal(entry));
      logs.push(message || `Rehashed table to size ${newSize}.`);
      return logs;
    }

    maintainAfterInsert() {
      const logs = [];
      const load = this.count / this.size;
      let maxChain = 0;
      for (const bucket of this.table) {
        if (bucket.length > maxChain) maxChain = bucket.length;
      }
      if (load > 1.15 || maxChain > 4) {
        const targetSize = nextPrime(Math.ceil(this.size * 1.6));
        if (targetSize !== this.size) {
          logs.push(
            ...this.rehash(
              targetSize,
              `Load factor ${load.toFixed(2)} or chain length ${maxChain} triggered growth to ${targetSize}.`
            )
          );
        }
      }
      return logs;
    }

    maintainAfterRemoval() {
      const logs = [];
      const load = this.count / this.size;
      if (this.size > MIN_TABLE_SIZE && load < 0.45) {
        const target = previousPrime(Math.max(MIN_TABLE_SIZE, Math.floor(this.size / 1.5)));
        if (target < this.size) {
          logs.push(
            ...this.rehash(
              target,
              `Load factor dropped to ${load.toFixed(2)}. Shrunk table to ${target}.`
            )
          );
        }
      }
      return logs;
    }

    insert(rawKey) {
      const key = this.normaliseKey(rawKey);
      const logs = [];
      const highlights = [];
      const index = this.primaryIndex(key);
      const bucket = this.table[index];
      logs.push(`hash("${key}") = ${index}`);
      highlights.push({ index, type: 'probe' });
      if (bucket.includes(key)) {
        logs.push(`Key "${key}" already exists in bucket ${index}.`);
        highlights.push({ index, type: 'found' });
        return { logs, highlights, status: 'duplicate' };
      }
      bucket.push(key);
      this.count += 1;
      logs.push(`Inserted "${key}" into bucket ${index}. Bucket length is now ${bucket.length}.`);
      highlights.push({ index, type: 'placed' });
      logs.push(...this.maintainAfterInsert());
      return { logs, highlights, status: 'inserted' };
    }

    search(rawKey) {
      const key = this.normaliseKey(rawKey);
      const logs = [];
      const highlights = [];
      const index = this.primaryIndex(key);
      const bucket = this.table[index];
      logs.push(`hash("${key}") = ${index}`);
      highlights.push({ index, type: 'probe' });
      const position = bucket.indexOf(key);
      if (position === -1) {
        logs.push(`Bucket ${index} scanned. "${key}" is not present.`);
        return { logs, highlights, status: 'missing' };
      }
      logs.push(`Found "${key}" at bucket ${index}, chain position ${position}.`);
      highlights.push({ index, type: 'found' });
      return { logs, highlights, status: 'found' };
    }

    remove(rawKey) {
      const key = this.normaliseKey(rawKey);
      const logs = [];
      const highlights = [];
      const index = this.primaryIndex(key);
      const bucket = this.table[index];
      logs.push(`hash("${key}") = ${index}`);
      highlights.push({ index, type: 'probe' });
      const position = bucket.indexOf(key);
      if (position === -1) {
        logs.push(`Nothing to delete. "${key}" does not live in bucket ${index}.`);
        return { logs, highlights, status: 'missing' };
      }
      bucket.splice(position, 1);
      this.count -= 1;
      logs.push(`Deleted "${key}" from bucket ${index}.`);
      highlights.push({ index, type: 'placed' });
      logs.push(...this.maintainAfterRemoval());
      return { logs, highlights, status: 'removed' };
    }

    snapshot() {
      return this.table.map((bucket, index) => ({
        index,
        state: bucket.length === 0 ? 'emptyChain' : 'chain',
        items: bucket.map((key) => ({ kind: 'value', label: key })),
      }));
    }

    stats() {
      const loadFactor = this.size === 0 ? 0 : this.count / this.size;
      let maxChain = 0;
      let chainTotal = 0;
      let nonEmpty = 0;
      for (const bucket of this.table) {
        const length = bucket.length;
        if (length > maxChain) maxChain = length;
        if (length > 0) {
          nonEmpty += 1;
          chainTotal += length;
        }
      }
      const averageChain = nonEmpty === 0 ? 0 : chainTotal / nonEmpty;
      return {
        size: this.size,
        keys: this.count,
        loadFactor,
        maxChain,
        averageChain,
        kind: 'chaining',
      };
    }
  }

  class OpenAddressingStrategy extends BaseStrategy {
    constructor(size) {
      super(size);
      this.clear();
    }

    clear() {
      this.table = Array.from({ length: this.size }, () => null);
      this.count = 0;
      this.tombstones = 0;
    }

    loadFactor() {
      return this.size === 0 ? 0 : this.count / this.size;
    }

    occupancy() {
      return this.size === 0 ? 0 : (this.count + this.tombstones) / this.size;
    }

    createContext(key) {
      return { base: this.primaryIndex(key) };
    }

    logContext(context, key, logs) {
      logs.push(`hash("${key}") = ${context.base}`);
    }

    probeInfo(context, attempt) {
      const index = (context.base + attempt) % this.size;
      return { index, note: `Probe ${attempt + 1}: slot ${index}` };
    }

    directInsert(key) {
      const context = this.createContext(key);
      for (let attempt = 0; attempt < this.size; attempt += 1) {
        const { index } = this.probeInfo(context, attempt, key);
        const entry = this.table[index];
        if (entry === null || entry === TOMBSTONE) {
          this.table[index] = key;
          this.count += 1;
          if (entry === TOMBSTONE) this.tombstones -= 1;
          return;
        }
      }
      throw new Error('Rehash failed to allocate slot.');
    }

    rehash(newSize, message) {
      const logs = [];
      const entries = [];
      for (const entry of this.table) {
        if (entry !== null && entry !== TOMBSTONE) {
          entries.push(entry);
        }
      }
      this.size = newSize;
      this.table = Array.from({ length: newSize }, () => null);
      this.count = 0;
      this.tombstones = 0;
      entries.forEach((entry) => this.directInsert(entry));
      logs.push(message || `Rehashed table to size ${newSize}.`);
      return logs;
    }

    ensureCapacityBeforeInsert() {
      const logs = [];
      const load = this.loadFactor();
      if (load > 0.68) {
        const target = nextPrime(Math.ceil(this.size * 1.6));
        if (target !== this.size) {
          logs.push(
            ...this.rehash(
              target,
              `Pre-emptive growth: load factor ${load.toFixed(2)} exceeded 0.68. Resized to ${target}.`
            )
          );
        }
      } else {
        const occupancy = this.occupancy();
        if (occupancy > 0.85 && this.tombstones > this.size * 0.15) {
          logs.push(
            ...this.rehash(
              this.size,
              'Tombstones building up. Rehashed to tighten probe chains.'
            )
          );
        }
      }
      return logs;
    }

    maintainAfterInsert() {
      const logs = [];
      const load = this.loadFactor();
      if (load > 0.72) {
        const target = nextPrime(Math.ceil(this.size * 1.35));
        if (target !== this.size) {
          logs.push(
            ...this.rehash(
              target,
              `Post-insert load factor ${load.toFixed(2)} triggered growth to ${target}.`
            )
          );
          return logs;
        }
      }
      const occupancy = this.occupancy();
      if (occupancy > 0.88 && this.tombstones > this.size * 0.18) {
        logs.push(
          ...this.rehash(
            this.size,
            'High tombstone ratio detected. Compacted the table to shorten probes.'
          )
        );
      }
      return logs;
    }

    maintainAfterRemoval() {
      const logs = [];
      if (this.size > MIN_TABLE_SIZE) {
        const load = this.loadFactor();
        if (this.count > 0 && load < 0.3) {
          const target = previousPrime(
            Math.max(MIN_TABLE_SIZE, Math.floor(this.size / 1.6))
          );
          if (target < this.size) {
            logs.push(
              ...this.rehash(
                target,
                `Load factor dropped to ${load.toFixed(2)}. Shrunk table to ${target}.`
              )
            );
            return logs;
          }
        }
        if (this.tombstones > this.size * 0.25 && this.tombstones > this.count) {
          logs.push(
            ...this.rehash(
              this.size,
              'Many tombstones present. Rehashed to clean them up.'
            )
          );
        }
      }
      return logs;
    }

    insert(rawKey) {
      const key = this.normaliseKey(rawKey);
      const logs = [...this.ensureCapacityBeforeInsert()];
      const highlights = [];
      const context = this.createContext(key);
      this.logContext(context, key, logs);

      let firstTombstone = -1;
      for (let attempt = 0; attempt < this.size; attempt += 1) {
        const { index, note } = this.probeInfo(context, attempt, key);
        if (note) logs.push(note);
        highlights.push({ index, type: 'probe' });
        const entry = this.table[index];
        if (entry === key) {
          logs.push(`Key "${key}" already stored at slot ${index}.`);
          highlights.push({ index, type: 'found' });
          return { logs, highlights, status: 'duplicate' };
        }
        if (entry === null) {
          const target = firstTombstone !== -1 ? firstTombstone : index;
          const previous = this.table[target];
          this.table[target] = key;
          this.count += 1;
          if (previous === TOMBSTONE) {
            this.tombstones -= 1;
            logs.push(`Reused tombstone at slot ${target} for "${key}".`);
          } else {
            logs.push(`Placed "${key}" at slot ${target}.`);
          }
          highlights.push({ index: target, type: 'placed' });
          logs.push(...this.maintainAfterInsert());
          return { logs, highlights, status: 'inserted' };
        }
        if (entry === TOMBSTONE && firstTombstone === -1) {
          firstTombstone = index;
        }
      }

      if (firstTombstone !== -1) {
        const previous = this.table[firstTombstone];
        this.table[firstTombstone] = key;
        this.count += 1;
        if (previous === TOMBSTONE) this.tombstones -= 1;
        logs.push(`Probe cycle wrapped; inserted "${key}" into tombstone ${firstTombstone}.`);
        highlights.push({ index: firstTombstone, type: 'placed' });
        logs.push(...this.maintainAfterInsert());
        return { logs, highlights, status: 'inserted' };
      }

      const growthLogs = this.rehash(
        nextPrime(Math.ceil(this.size * 1.6)),
        'Table was saturated. Rehashed to a larger prime size to continue probing.'
      );
      const result = this.insert(key);
      return {
        logs: [...logs, ...growthLogs, ...result.logs],
        highlights: result.highlights,
        status: result.status,
      };
    }

    search(rawKey) {
      const key = this.normaliseKey(rawKey);
      const logs = [];
      const highlights = [];
      const context = this.createContext(key);
      this.logContext(context, key, logs);
      for (let attempt = 0; attempt < this.size; attempt += 1) {
        const { index, note } = this.probeInfo(context, attempt, key);
        if (note) logs.push(note);
        highlights.push({ index, type: 'probe' });
        const entry = this.table[index];
        if (entry === key) {
          logs.push(`Success! "${key}" found at slot ${index}.`);
          highlights.push({ index, type: 'found' });
          return { logs, highlights, status: 'found' };
        }
        if (entry === null) {
          logs.push('Encountered an empty slot. Key not present.');
          return { logs, highlights, status: 'missing' };
        }
      }
      logs.push('Probe cycle completed with no match.');
      return { logs, highlights, status: 'missing' };
    }

    remove(rawKey) {
      const key = this.normaliseKey(rawKey);
      const logs = [];
      const highlights = [];
      const context = this.createContext(key);
      this.logContext(context, key, logs);
      for (let attempt = 0; attempt < this.size; attempt += 1) {
        const { index, note } = this.probeInfo(context, attempt, key);
        if (note) logs.push(note);
        highlights.push({ index, type: 'probe' });
        const entry = this.table[index];
        if (entry === key) {
          this.table[index] = TOMBSTONE;
          this.count -= 1;
          this.tombstones += 1;
          logs.push(`Marked slot ${index} as tombstone.`);
          highlights.push({ index, type: 'placed' });
          logs.push(...this.maintainAfterRemoval());
          return { logs, highlights, status: 'removed' };
        }
        if (entry === null) {
          logs.push('Encountered an empty slot before finding the key. Nothing removed.');
          return { logs, highlights, status: 'missing' };
        }
      }
      logs.push('Probe cycle completed with no deletion.');
      return { logs, highlights, status: 'missing' };
    }

    snapshot() {
      return this.table.map((entry, index) => {
        if (entry === null) {
          return { index, state: 'empty', items: [] };
        }
        if (entry === TOMBSTONE) {
          return { index, state: 'tombstone', items: [] };
        }
        return {
          index,
          state: 'value',
          items: [{ kind: 'value', label: entry }],
        };
      });
    }

    stats() {
      return {
        size: this.size,
        keys: this.count,
        loadFactor: this.loadFactor(),
        tombstones: this.tombstones,
        occupancy: this.occupancy(),
        kind: 'open',
      };
    }
  }

  class LinearProbingStrategy extends OpenAddressingStrategy {}

  class QuadraticProbingStrategy extends OpenAddressingStrategy {
    probeInfo(context, attempt) {
      const offset = attempt * attempt;
      const index = (context.base + offset) % this.size;
      return { index, note: `Probe ${attempt + 1}: +${offset} ⇒ slot ${index}` };
    }
  }

  class DoubleHashingStrategy extends OpenAddressingStrategy {
    createContext(key) {
      const base = this.primaryIndex(key);
      const step = this.secondaryStep(key);
      return { base, step };
    }

    logContext(context, key, logs) {
      super.logContext(context, key, logs);
      logs.push(`step("${key}") = ${context.step}`);
    }

    probeInfo(context, attempt) {
      const index = (context.base + attempt * context.step) % this.size;
      return { index, note: `Probe ${attempt + 1}: slot ${index}` };
    }
  }

  const strategyFactories = {
    separateChaining: (size) => new SeparateChainingStrategy(size),
    linearProbing: (size) => new LinearProbingStrategy(size),
    quadraticProbing: (size) => new QuadraticProbingStrategy(size),
    doubleHashing: (size) => new DoubleHashingStrategy(size),
  };

  class HashingController {
    constructor() {
      this.sizeInput = document.getElementById('tableSize');
      this.strategySelect = document.getElementById('strategy');
      this.keyInput = document.getElementById('keyInput');
      this.tableElement = document.getElementById('hashTable');
      this.logElement = document.getElementById('log');
      this.template = document.getElementById('bucketTemplate');
      this.animationTimers = [];

      this.strategyName = this.strategySelect.value;
      this.tableSize = normaliseSizeForStrategy(
        Number(this.sizeInput.value) || 11,
        this.strategyName
      );
      this.sizeInput.value = this.tableSize;
      this.strategy = strategyFactories[this.strategyName](this.tableSize);

      this.attachEvents();
      this.render();
      this.writeLog([
        `Ready! Using ${strategyLabels[this.strategyName]} with table size ${this.tableSize}.`,
      ]);
    }

    attachEvents() {
      document.getElementById('insertBtn').addEventListener('click', () =>
        this.handleAction('insert')
      );
      document.getElementById('searchBtn').addEventListener('click', () =>
        this.handleAction('search')
      );
      document.getElementById('deleteBtn').addEventListener('click', () =>
        this.handleAction('remove')
      );
      document.getElementById('resetBtn').addEventListener('click', () => {
        this.resetTable();
        this.writeLog([
          `Cleared the table. Still using ${strategyLabels[this.strategyName]} with size ${this.tableSize}.`,
        ]);
      });

      this.strategySelect.addEventListener('change', () => {
        this.strategyName = this.strategySelect.value;
        this.tableSize = normaliseSizeForStrategy(
          Number(this.sizeInput.value) || this.tableSize,
          this.strategyName
        );
        this.sizeInput.value = this.tableSize;
        this.resetTable(false);
        this.writeLog([
          `Switched to ${strategyLabels[this.strategyName]}. Table refreshed at size ${this.tableSize}.`,
        ]);
      });

      this.sizeInput.addEventListener('change', () => {
        const parsed = normaliseSizeForStrategy(
          Number(this.sizeInput.value) || this.tableSize,
          this.strategyName
        );
        this.tableSize = parsed;
        this.sizeInput.value = parsed;
        this.resetTable(false);
        this.writeLog([
          `Changed table size to ${parsed}. Starting fresh with ${strategyLabels[this.strategyName]}.`,
        ]);
      });

      this.keyInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          this.handleAction('insert');
        }
      });
    }

    resetTable(renderLog = true) {
      this.strategy = strategyFactories[this.strategyName](this.tableSize);
      this.render();
      if (!renderLog) return;
      this.writeLog([
        `Table reset. Ready with ${strategyLabels[this.strategyName]} (${this.tableSize} slots).`,
      ]);
    }

    handleAction(action) {
      const rawKey = this.keyInput.value.trim();
      if (!rawKey) {
        this.writeLog(['Enter a key (text or number) to run the operation.']);
        this.keyInput.focus();
        return;
      }

      let result;
      switch (action) {
        case 'insert':
          result = this.strategy.insert(rawKey);
          break;
        case 'search':
          result = this.strategy.search(rawKey);
          break;
        case 'remove':
          result = this.strategy.remove(rawKey);
          break;
        default:
          result = { logs: ['Unknown action.'], highlights: [] };
      }

      this.render(result?.highlights || []);
      this.playAnimation(result?.highlights || []);
      if (result?.logs?.length) {
        this.writeLog(result.logs);
      }
    }

    render(highlights = []) {
      this.tableSize = this.strategy.size;
      if (Number(this.sizeInput.value) !== this.tableSize) {
        this.sizeInput.value = this.tableSize;
      }

      this.clearAnimations();

      const fragment = document.createDocumentFragment();
      const snapshot = this.strategy.snapshot();
      const highlightMap = new Map();

      highlights.forEach(({ index, type }) => {
        if (!highlightMap.has(index)) {
          highlightMap.set(index, { accent: false });
        }
        if (type === 'placed' || type === 'found') {
          const record = highlightMap.get(index);
          record.accent = true;
        }
      });

      snapshot.forEach((bucket) => {
        const clone = this.template.content.firstElementChild.cloneNode(true);
        const indexEl = clone.querySelector('.index');
        const slotEl = clone.querySelector('.slot');
        indexEl.textContent = bucket.index;
        clone.dataset.index = String(bucket.index);

        const highlight = highlightMap.get(bucket.index);
        if (highlight?.accent) {
          clone.classList.add('final-highlight');
        }

        if (bucket.items.length === 0) {
          const placeholder = document.createElement('div');
          placeholder.className = 'item';
          let placeholderState = 'empty';
          if (bucket.state === 'tombstone') placeholderState = 'tombstone';
          if (bucket.state === 'emptyChain') placeholderState = 'empty';
          placeholder.dataset.state = placeholderState;
          placeholder.textContent = this.placeholderLabel(bucket.state);
          slotEl.appendChild(placeholder);
        } else {
          bucket.items.forEach((item) => {
            const chip = document.createElement('div');
            chip.className = 'item';
            chip.dataset.state = item.kind || 'value';
            const keySpan = document.createElement('span');
            keySpan.className = 'key';
            keySpan.textContent = item.label;
            chip.appendChild(keySpan);
            slotEl.appendChild(chip);
          });
        }

        fragment.appendChild(clone);
      });

      this.tableElement.innerHTML = '';
      this.tableElement.appendChild(fragment);
    }

    placeholderLabel(state) {
      switch (state) {
        case 'tombstone':
          return 'tombstone';
        case 'emptyChain':
          return 'empty chain';
        case 'chain':
          return 'chain';
        default:
          return 'empty';
      }
    }

    clearAnimations() {
      this.animationTimers.forEach((timer) => clearTimeout(timer));
      this.animationTimers = [];
      if (!this.tableElement) return;
      this.tableElement
        .querySelectorAll('.bucket')
        .forEach((bucket) => bucket.classList.remove('animate-probe', 'animate-hit'));
    }

    playAnimation(highlights = []) {
      if (!Array.isArray(highlights) || highlights.length === 0) {
        return;
      }

      this.clearAnimations();

      highlights.forEach((entry, order) => {
        const bucketEl = this.tableElement.querySelector(
          `.bucket[data-index="${entry.index}"]`
        );
        if (!bucketEl) return;
        const delay = order * 320;
        const timer = setTimeout(() => {
          const className =
            entry.type === 'placed' || entry.type === 'found'
              ? 'animate-hit'
              : 'animate-probe';
          bucketEl.classList.add(className);
          bucketEl.addEventListener(
            'animationend',
            () => {
              bucketEl.classList.remove(className);
            },
            { once: true }
          );
        }, delay);
        this.animationTimers.push(timer);
      });
    }

    writeLog(messages) {
      this.logElement.innerHTML = '';
      messages.forEach((message) => {
        const item = document.createElement('li');
        item.textContent = message;
        this.logElement.appendChild(item);
      });
      this.logElement.scrollTop = this.logElement.scrollHeight;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    new HashingController();
  });
})();

