import { Parser, Language } from './web-tree-sitter.js';


export class Pos {
    static __wrap(ptr) {
        const obj = Object.create(Pos.prototype);
        obj.__wbg_ptr = ptr;
        PosFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PosFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_pos_free(ptr, 0);
    }
    /**
     * column number starting from 0
     * @returns {number}
     */
    get column() {
        const ret = wasm.__wbg_get_pos_column(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * character offset of the position
     * @returns {number}
     */
    get index() {
        const ret = wasm.__wbg_get_pos_index(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * line number starting from 0
     * @returns {number}
     */
    get line() {
        const ret = wasm.__wbg_get_pos_line(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * column number starting from 0
     * @param {number} arg0
     */
    set column(arg0) {
        wasm.__wbg_set_pos_column(this.__wbg_ptr, arg0);
    }
    /**
     * character offset of the position
     * @param {number} arg0
     */
    set index(arg0) {
        wasm.__wbg_set_pos_index(this.__wbg_ptr, arg0);
    }
    /**
     * line number starting from 0
     * @param {number} arg0
     */
    set line(arg0) {
        wasm.__wbg_set_pos_line(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) Pos.prototype[Symbol.dispose] = Pos.prototype.free;

export class Range {
    static __wrap(ptr) {
        const obj = Object.create(Range.prototype);
        obj.__wbg_ptr = ptr;
        RangeFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RangeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_range_free(ptr, 0);
    }
    /**
     * ending position of the range
     * @returns {Pos}
     */
    get end() {
        const ret = wasm.__wbg_get_range_end(this.__wbg_ptr);
        return Pos.__wrap(ret);
    }
    /**
     * starting position of the range
     * @returns {Pos}
     */
    get start() {
        const ret = wasm.__wbg_get_range_start(this.__wbg_ptr);
        return Pos.__wrap(ret);
    }
    /**
     * ending position of the range
     * @param {Pos} arg0
     */
    set end(arg0) {
        _assertClass(arg0, Pos);
        var ptr0 = arg0.__destroy_into_raw();
        wasm.__wbg_set_range_end(this.__wbg_ptr, ptr0);
    }
    /**
     * starting position of the range
     * @param {Pos} arg0
     */
    set start(arg0) {
        _assertClass(arg0, Pos);
        var ptr0 = arg0.__destroy_into_raw();
        wasm.__wbg_set_range_start(this.__wbg_ptr, ptr0);
    }
}
if (Symbol.dispose) Range.prototype[Symbol.dispose] = Range.prototype.free;

/**
 * Represents a single AST node.
 */
export class SgNode {
    static __wrap(ptr) {
        const obj = Object.create(SgNode.prototype);
        obj.__wbg_ptr = ptr;
        SgNodeFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SgNodeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sgnode_free(ptr, 0);
    }
    /**
     * @returns {SgNode[]}
     */
    ancestors() {
        const ret = wasm.sgnode_ancestors(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {number} nth
     * @returns {SgNode | undefined}
     */
    child(nth) {
        const ret = wasm.sgnode_child(this.__wbg_ptr, nth);
        return ret === 0 ? undefined : SgNode.__wrap(ret);
    }
    /**
     * @returns {SgNode[]}
     */
    children() {
        const ret = wasm.sgnode_children(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @deprecated Use `children` instead.
     * @returns {SgNode[]}
     */
    children_nodes() {
        const ret = wasm.sgnode_children_nodes(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {any} edits
     * @returns {string}
     */
    commitEdits(edits) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.sgnode_commitEdits(this.__wbg_ptr, edits);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {string} name
     * @returns {SgNode | undefined}
     */
    field(name) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sgnode_field(this.__wbg_ptr, ptr0, len0);
        return ret === 0 ? undefined : SgNode.__wrap(ret);
    }
    /**
     * @param {string} name
     * @returns {SgNode[]}
     */
    fieldChildren(name) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sgnode_fieldChildren(this.__wbg_ptr, ptr0, len0);
        var v2 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * @param {any} matcher
     * @returns {SgNode | undefined}
     */
    find(matcher) {
        const ret = wasm.sgnode_find(this.__wbg_ptr, matcher);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] === 0 ? undefined : SgNode.__wrap(ret[0]);
    }
    /**
     * @param {any} matcher
     * @returns {SgNode[]}
     */
    findAll(matcher) {
        const ret = wasm.sgnode_findAll(this.__wbg_ptr, matcher);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {any} m
     * @returns {boolean}
     */
    follows(m) {
        const ret = wasm.sgnode_follows(this.__wbg_ptr, m);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @param {string} m
     * @returns {SgNode | undefined}
     */
    getMatch(m) {
        const ptr0 = passStringToWasm0(m, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sgnode_getMatch(this.__wbg_ptr, ptr0, len0);
        return ret === 0 ? undefined : SgNode.__wrap(ret);
    }
    /**
     * @param {string} m
     * @returns {SgNode[]}
     */
    getMultipleMatches(m) {
        const ptr0 = passStringToWasm0(m, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sgnode_getMultipleMatches(this.__wbg_ptr, ptr0, len0);
        var v2 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * @param {string} m
     * @returns {string | undefined}
     */
    getTransformed(m) {
        const ptr0 = passStringToWasm0(m, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sgnode_getTransformed(this.__wbg_ptr, ptr0, len0);
        let v2;
        if (ret[0] !== 0) {
            v2 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v2;
    }
    /**
     * @param {any} m
     * @returns {boolean}
     */
    has(m) {
        const ret = wasm.sgnode_has(this.__wbg_ptr, m);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @returns {number}
     */
    id() {
        const ret = wasm.sgnode_id(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {any} m
     * @returns {boolean}
     */
    inside(m) {
        const ret = wasm.sgnode_inside(this.__wbg_ptr, m);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @param {string} kind
     * @returns {boolean}
     */
    is(kind) {
        const ptr0 = passStringToWasm0(kind, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sgnode_is(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    isLeaf() {
        const ret = wasm.sgnode_isLeaf(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    isNamed() {
        const ret = wasm.sgnode_isNamed(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    isNamedLeaf() {
        const ret = wasm.sgnode_isNamedLeaf(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {string}
     */
    kind() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.sgnode_kind(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {any} m
     * @returns {boolean}
     */
    matches(m) {
        const ret = wasm.sgnode_matches(this.__wbg_ptr, m);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @returns {SgNode[]}
     */
    namedChildren() {
        const ret = wasm.sgnode_namedChildren(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {SgNode | undefined}
     */
    next() {
        const ret = wasm.sgnode_next(this.__wbg_ptr);
        return ret === 0 ? undefined : SgNode.__wrap(ret);
    }
    /**
     * @returns {SgNode[]}
     */
    nextAll() {
        const ret = wasm.sgnode_nextAll(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {SgNode | undefined}
     */
    parent() {
        const ret = wasm.sgnode_parent(this.__wbg_ptr);
        return ret === 0 ? undefined : SgNode.__wrap(ret);
    }
    /**
     * @deprecated Use `parent` instead.
     * @returns {SgNode | undefined}
     */
    parent_node() {
        const ret = wasm.sgnode_parent_node(this.__wbg_ptr);
        return ret === 0 ? undefined : SgNode.__wrap(ret);
    }
    /**
     * @param {any} m
     * @returns {boolean}
     */
    precedes(m) {
        const ret = wasm.sgnode_precedes(this.__wbg_ptr, m);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @returns {SgNode | undefined}
     */
    prev() {
        const ret = wasm.sgnode_prev(this.__wbg_ptr);
        return ret === 0 ? undefined : SgNode.__wrap(ret);
    }
    /**
     * @returns {SgNode[]}
     */
    prevAll() {
        const ret = wasm.sgnode_prevAll(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Range}
     */
    range() {
        const ret = wasm.sgnode_range(this.__wbg_ptr);
        return Range.__wrap(ret);
    }
    /**
     * @param {string} text
     * @returns {WasmEdit}
     */
    replace(text) {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sgnode_replace(this.__wbg_ptr, ptr0, len0);
        return WasmEdit.__wrap(ret);
    }
    /**
     * @returns {string}
     */
    text() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.sgnode_text(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) SgNode.prototype[Symbol.dispose] = SgNode.prototype.free;

/**
 * Represents the parsed tree of code.
 */
export class SgRoot {
    static __wrap(ptr) {
        const obj = Object.create(SgRoot.prototype);
        obj.__wbg_ptr = ptr;
        SgRootFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SgRootFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sgroot_free(ptr, 0);
    }
    /**
     * Returns the path of the file if it is discovered by ast-grep's `findInFiles`.
     * Returns `"anonymous"` if the instance is created by `parse`.
     * @returns {string}
     */
    filename() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.sgroot_filename(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * This method is mainly for debugging tree parsing result.
     * @returns {any}
     */
    getInnerTree() {
        const ret = wasm.sgroot_getInnerTree(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns the root SgNode of the ast-grep instance.
     * @returns {SgNode}
     */
    root() {
        const ret = wasm.sgroot_root(this.__wbg_ptr);
        return SgNode.__wrap(ret);
    }
}
if (Symbol.dispose) SgRoot.prototype[Symbol.dispose] = SgRoot.prototype.free;

export class WasmEdit {
    static __wrap(ptr) {
        const obj = Object.create(WasmEdit.prototype);
        obj.__wbg_ptr = ptr;
        WasmEditFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmEditFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmedit_free(ptr, 0);
    }
    /**
     * The end position of the edit (character offset)
     * @returns {number}
     */
    get end_pos() {
        const ret = wasm.__wbg_get_wasmedit_end_pos(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * The text to be inserted
     * @returns {string}
     */
    get inserted_text() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.__wbg_get_wasmedit_inserted_text(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The start position of the edit (character offset)
     * @returns {number}
     */
    get start_pos() {
        const ret = wasm.__wbg_get_wasmedit_start_pos(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * The end position of the edit (character offset)
     * @param {number} arg0
     */
    set end_pos(arg0) {
        wasm.__wbg_set_wasmedit_end_pos(this.__wbg_ptr, arg0);
    }
    /**
     * The text to be inserted
     * @param {string} arg0
     */
    set inserted_text(arg0) {
        const ptr0 = passStringToWasm0(arg0, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.__wbg_set_wasmedit_inserted_text(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * The start position of the edit (character offset)
     * @param {number} arg0
     */
    set start_pos(arg0) {
        wasm.__wbg_set_wasmedit_start_pos(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) WasmEdit.prototype[Symbol.dispose] = WasmEdit.prototype.free;

/**
 * Dump a pattern's internal structure for inspection.
 * `selector` is an optional kind name for contextual patterns.
 * `strictness` is one of: "cst", "smart", "ast", "relaxed", "signature", "template".
 * Returns a tree structure showing how ast-grep parses the pattern, including source positions.
 * @param {string} lang
 * @param {string} pattern_str
 * @param {string | null} [selector]
 * @param {string | null} [strictness]
 * @returns {any}
 */
export function dumpPattern(lang, pattern_str, selector, strictness) {
    const ptr0 = passStringToWasm0(lang, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(pattern_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    var ptr2 = isLikeNone(selector) ? 0 : passStringToWasm0(selector, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len2 = WASM_VECTOR_LEN;
    var ptr3 = isLikeNone(strictness) ? 0 : passStringToWasm0(strictness, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len3 = WASM_VECTOR_LEN;
    const ret = wasm.dumpPattern(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Initialize the tree-sitter WASM runtime.
 * Must be called before any other function.
 * @returns {Promise<void>}
 */
export function initializeTreeSitter() {
    const ret = wasm.initializeTreeSitter();
    return ret;
}

/**
 * Get the `kind` number from its string name.
 * @param {string} lang
 * @param {string} kind_name
 * @returns {number}
 */
export function kind(lang, kind_name) {
    const ptr0 = passStringToWasm0(lang, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(kind_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.kind(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

/**
 * Parse a string to an ast-grep instance.
 * @param {string} lang
 * @param {string} src
 * @returns {SgRoot}
 */
export function parse(lang, src) {
    const ptr0 = passStringToWasm0(lang, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(src, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.parse(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return SgRoot.__wrap(ret[0]);
}

/**
 * Compile a string to ast-grep Pattern config.
 * @param {string} lang
 * @param {string} pattern_str
 * @returns {any}
 */
export function pattern(lang, pattern_str) {
    const ptr0 = passStringToWasm0(lang, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(pattern_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.pattern(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Register dynamic languages for parsing.
 * `langs` is a Map of language name to its registration config
 * (with `libraryPath` and optional `expandoChar`).
 * Can be called multiple times; existing languages are updated.
 * @param {any} langs
 * @returns {Promise<void>}
 */
export function registerDynamicLanguage(langs) {
    const ret = wasm.registerDynamicLanguage(langs);
    return ret;
}
export function __wbg_Error_408e67f47ca7b58b(arg0, arg1) {
    const ret = Error(getStringFromWasm0(arg0, arg1));
    return ret;
}
export function __wbg_Number_3890faa6d3ff057d(arg0) {
    const ret = Number(arg0);
    return ret;
}
export function __wbg_String_8564e559799eccda(arg0, arg1) {
    const ret = String(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___new_8005f3919f7b271a() { return handleError(function () {
    const ret = new Parser();
    return ret;
}, arguments); }
export function __wbg___wbindgen_bigint_get_as_i64_c4ecf48528083721(arg0, arg1) {
    const v = arg1;
    const ret = typeof(v) === 'bigint' ? v : undefined;
    getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
}
export function __wbg___wbindgen_boolean_get_c9c83ebd41b34df3(arg0) {
    const v = arg0;
    const ret = typeof(v) === 'boolean' ? v : undefined;
    return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
}
export function __wbg___wbindgen_debug_string_a57024b9c6e4a48b(arg0, arg1) {
    const ret = debugString(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_in_ac983077f137f2e6(arg0, arg1) {
    const ret = arg0 in arg1;
    return ret;
}
export function __wbg___wbindgen_is_bigint_8ffbbef442139384(arg0) {
    const ret = typeof(arg0) === 'bigint';
    return ret;
}
export function __wbg___wbindgen_is_function_5e4570eb24ffa122(arg0) {
    const ret = typeof(arg0) === 'function';
    return ret;
}
export function __wbg___wbindgen_is_object_a2790eb24c211ea0(arg0) {
    const val = arg0;
    const ret = typeof(val) === 'object' && val !== null;
    return ret;
}
export function __wbg___wbindgen_is_string_e6f02f0ea5f20a32(arg0) {
    const ret = typeof(arg0) === 'string';
    return ret;
}
export function __wbg___wbindgen_is_undefined_6cff064c44e0d823(arg0) {
    const ret = arg0 === undefined;
    return ret;
}
export function __wbg___wbindgen_jsval_eq_0a18949a61670320(arg0, arg1) {
    const ret = arg0 === arg1;
    return ret;
}
export function __wbg___wbindgen_jsval_loose_eq_acf2776254a8d832(arg0, arg1) {
    const ret = arg0 == arg1;
    return ret;
}
export function __wbg___wbindgen_number_get_136b9679cab35cfb(arg0, arg1) {
    const obj = arg1;
    const ret = typeof(obj) === 'number' ? obj : undefined;
    getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
}
export function __wbg___wbindgen_string_get_d154f1e671052120(arg0, arg1) {
    const obj = arg1;
    const ret = typeof(obj) === 'string' ? obj : undefined;
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_throw_bb96b2010945f0bc(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
}
export function __wbg__wbg_cb_unref_be22cc64ae6946a0(arg0) {
    arg0._wbg_cb_unref();
}
export function __wbg_call_1c5886ab9c57d1c7() { return handleError(function (arg0, arg1) {
    const ret = arg0.call(arg1);
    return ret;
}, arguments); }
export function __wbg_call_35dba3c747ad7521() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.call(arg1, arg2);
    return ret;
}, arguments); }
export function __wbg_childCount_d8aaf0e3b93eea12(arg0) {
    const ret = arg0.childCount;
    return ret;
}
export function __wbg_childForFieldId_73cea7e74372ed59(arg0, arg1) {
    const ret = arg0.childForFieldId(arg1);
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_childForFieldName_1829a5f1673c0dad(arg0, arg1, arg2) {
    const ret = arg0.childForFieldName(getStringFromWasm0(arg1, arg2));
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_child_7bea5d11903b134c(arg0, arg1) {
    const ret = arg0.child(arg1 >>> 0);
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_children_0977beddc563103f(arg0, arg1) {
    const ret = arg1.children;
    const ptr1 = passArrayJsValueToWasm0(ret, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_codePointAt_62da65794259e6a8(arg0, arg1) {
    const ret = arg0.codePointAt(arg1 >>> 0);
    return ret;
}
export function __wbg_column_076580619ff9aea2(arg0) {
    const ret = arg0.column;
    return ret;
}
export function __wbg_copy_3abc29c702ee67cc(arg0) {
    const ret = arg0.copy();
    return ret;
}
export function __wbg_currentFieldId_cb28a5abad23c5b4(arg0) {
    const ret = arg0.currentFieldId;
    return isLikeNone(ret) ? 0xFFFFFF : ret;
}
export function __wbg_currentNode_3917c1392a4292c0(arg0) {
    const ret = arg0.currentNode;
    return ret;
}
export function __wbg_done_669171204c3dcae2(arg0) {
    const ret = arg0.done;
    return ret;
}
export function __wbg_endIndex_d05237fa6f4a8b0a(arg0) {
    const ret = arg0.endIndex;
    return ret;
}
export function __wbg_endPosition_99d8f8b69b1bb4ef(arg0) {
    const ret = arg0.endPosition;
    return ret;
}
export function __wbg_entries_7774d489e1da5f4f(arg0) {
    const ret = Object.entries(arg0);
    return ret;
}
export function __wbg_fieldIdForName_c873804366f5105f(arg0, arg1, arg2) {
    const ret = arg0.fieldIdForName(getStringFromWasm0(arg1, arg2));
    return isLikeNone(ret) ? 0xFFFFFF : ret;
}
export function __wbg_get_c0c8f8d7da0c03dd(arg0, arg1) {
    const ret = arg0[arg1 >>> 0];
    return ret;
}
export function __wbg_get_d173c0308df22d37() { return handleError(function (arg0, arg1) {
    const ret = Reflect.get(arg0, arg1);
    return ret;
}, arguments); }
export function __wbg_get_unchecked_e20b893aeafc3fca(arg0, arg1) {
    const ret = arg0[arg1 >>> 0];
    return ret;
}
export function __wbg_get_with_ref_key_6412cf3094599694(arg0, arg1) {
    const ret = arg0[arg1];
    return ret;
}
export function __wbg_gotoFirstChild_41dc290d8e42b3d1(arg0) {
    const ret = arg0.gotoFirstChild();
    return ret;
}
export function __wbg_gotoNextSibling_e36072360b45d902(arg0) {
    const ret = arg0.gotoNextSibling();
    return ret;
}
export function __wbg_idForNodeType_9f81cba784c9098c(arg0, arg1, arg2, arg3) {
    const ret = arg0.idForNodeType(getStringFromWasm0(arg1, arg2), arg3 !== 0);
    return ret;
}
export function __wbg_id_2e257a3a9915e451(arg0) {
    const ret = arg0.id;
    return ret;
}
export function __wbg_init_039f54bd8b876483() {
    const ret = Parser.init();
    return ret;
}
export function __wbg_instanceof_ArrayBuffer_993d02d2d254cad1(arg0) {
    let result;
    try {
        result = arg0 instanceof ArrayBuffer;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_Error_61d8a02a0f3383a1(arg0) {
    let result;
    try {
        result = arg0 instanceof Error;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_Map_9a4d6ead180ae3a9(arg0) {
    let result;
    try {
        result = arg0 instanceof Map;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_Uint8Array_f935dbb0aa7cdeed(arg0) {
    let result;
    try {
        result = arg0 instanceof Uint8Array;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_isArray_6339f732981044bf(arg0) {
    const ret = Array.isArray(arg0);
    return ret;
}
export function __wbg_isMissing_750a6f2bedfd98fa(arg0) {
    const ret = arg0.isMissing;
    return ret;
}
export function __wbg_isNamed_5fe6b39da59dc02d(arg0) {
    const ret = arg0.isNamed;
    return ret;
}
export function __wbg_isSafeInteger_f3d6cd19ccfe4512(arg0) {
    const ret = Number.isSafeInteger(arg0);
    return ret;
}
export function __wbg_iterator_5cebbb86e33c6dd6() {
    const ret = Symbol.iterator;
    return ret;
}
export function __wbg_language_204b19906c539c08(arg0) {
    const ret = arg0.language;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_length_36bd29c6848c2144(arg0) {
    const ret = arg0.length;
    return ret;
}
export function __wbg_length_7afd83ae4ddf324f(arg0) {
    const ret = arg0.length;
    return ret;
}
export function __wbg_length_ecfa2c63d3d0d82c(arg0) {
    const ret = arg0.length;
    return ret;
}
export function __wbg_load_c595a97a6b7b92ed(arg0, arg1) {
    const ret = Language.load(getStringFromWasm0(arg0, arg1));
    return ret;
}
export function __wbg_message_c141d5e68716b595(arg0) {
    const ret = arg0.message;
    return ret;
}
export function __wbg_namedChildCount_3d2c2553b2939997(arg0) {
    const ret = arg0.namedChildCount;
    return ret;
}
export function __wbg_new_116be93542d39019() {
    const ret = new Array();
    return ret;
}
export function __wbg_new_77cc4f4f472aeb81(arg0) {
    const ret = new Uint8Array(arg0);
    return ret;
}
export function __wbg_new_cdf041679ded4c5f() {
    const ret = new Map();
    return ret;
}
export function __wbg_new_ebe3e0f6837f0879() {
    const ret = new Object();
    return ret;
}
export function __wbg_new_typed_cceaf62d8d95e9f2(arg0, arg1) {
    try {
        var state0 = {a: arg0, b: arg1};
        var cb0 = (arg0, arg1) => {
            const a = state0.a;
            state0.a = 0;
            try {
                return wasm_bindgen_a8bde3ea5cc027a0___convert__closures_____invoke___js_sys_cc2eacbe17070be6___Function_fn_wasm_bindgen_a8bde3ea5cc027a0___JsValue_____wasm_bindgen_a8bde3ea5cc027a0___sys__Undefined___js_sys_cc2eacbe17070be6___Function_fn_wasm_bindgen_a8bde3ea5cc027a0___JsValue_____wasm_bindgen_a8bde3ea5cc027a0___sys__Undefined_______true_(a, state0.b, arg0, arg1);
            } finally {
                state0.a = a;
            }
        };
        const ret = new Promise(cb0);
        return ret;
    } finally {
        state0.a = 0;
    }
}
export function __wbg_nextSibling_b83b496dd1580d84(arg0) {
    const ret = arg0.nextSibling;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_next_42cf16ee0dafc9e2() { return handleError(function (arg0) {
    const ret = arg0.next();
    return ret;
}, arguments); }
export function __wbg_next_8f26b64fa5e9f64b(arg0) {
    const ret = arg0.next;
    return ret;
}
export function __wbg_parent_640730f3ac820299(arg0) {
    const ret = arg0.parent;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_parse_825108731c69996f() { return handleError(function (arg0, arg1, arg2, arg3) {
    const ret = arg0.parse(arg1, arg2, arg3);
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}, arguments); }
export function __wbg_previousSibling_a4dca02e405d4645(arg0) {
    const ret = arg0.previousSibling;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_prototypesetcall_de8e0d9553586985(arg0, arg1, arg2) {
    Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
}
export function __wbg_queueMicrotask_ac694eae12e92dfb(arg0) {
    queueMicrotask(arg0);
}
export function __wbg_queueMicrotask_be5fe34a8f4cad4d(arg0) {
    const ret = arg0.queueMicrotask;
    return ret;
}
export function __wbg_resolve_020f95d838c6ef25(arg0) {
    const ret = Promise.resolve(arg0);
    return ret;
}
export function __wbg_rootNode_b8df7f9d43d00070(arg0) {
    const ret = arg0.rootNode;
    return ret;
}
export function __wbg_row_8a9a4afcad5a6d7a(arg0) {
    const ret = arg0.row;
    return ret;
}
export function __wbg_setLanguage_19dcee4c8d25989c() { return handleError(function (arg0, arg1) {
    arg0.setLanguage(arg1);
}, arguments); }
export function __wbg_set_014226dfeca53178(arg0, arg1, arg2) {
    const ret = arg0.set(arg1, arg2);
    return ret;
}
export function __wbg_set_6be42768c690e380(arg0, arg1, arg2) {
    arg0[arg1] = arg2;
}
export function __wbg_set_a80955eb93b145c6(arg0, arg1, arg2) {
    arg0[arg1 >>> 0] = arg2;
}
export function __wbg_sgnode_new(arg0) {
    const ret = SgNode.__wrap(arg0);
    return ret;
}
export function __wbg_startIndex_0c139f76ee902c19(arg0) {
    const ret = arg0.startIndex;
    return ret;
}
export function __wbg_startPosition_0a0b8aa8046af922(arg0) {
    const ret = arg0.startPosition;
    return ret;
}
export function __wbg_static_accessor_GLOBAL_THIS_466428f93b4eaa76() {
    const ret = typeof globalThis === 'undefined' ? null : globalThis;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_GLOBAL_c7aea38d4de089bc() {
    const ret = typeof global === 'undefined' ? null : global;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_SELF_42d4fae05e59267a() {
    const ret = typeof self === 'undefined' ? null : self;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_WINDOW_e0db14a0eba6a812() {
    const ret = typeof window === 'undefined' ? null : window;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_text_485070d4cba6a6ee(arg0) {
    const ret = arg0.text;
    return ret;
}
export function __wbg_then_7026b513a94278a8(arg0, arg1) {
    const ret = arg0.then(arg1);
    return ret;
}
export function __wbg_then_72819b8d4e081fb5(arg0, arg1, arg2) {
    const ret = arg0.then(arg1, arg2);
    return ret;
}
export function __wbg_typeId_3a345d5d277993a7(arg0) {
    const ret = arg0.typeId;
    return ret;
}
export function __wbg_type_b16c468ba87b24b0(arg0) {
    const ret = arg0.type;
    return ret;
}
export function __wbg_value_1e2369fab29b420e(arg0) {
    const ret = arg0.value;
    return ret;
}
export function __wbg_walk_b869eec88169b920(arg0) {
    const ret = arg0.walk();
    return ret;
}
export function __wbindgen_cast_0000000000000001(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 387, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen_a8bde3ea5cc027a0___convert__closures_____invoke___wasm_bindgen_a8bde3ea5cc027a0___JsValue__core_608f92abc48d28da___result__Result_____wasm_bindgen_a8bde3ea5cc027a0___JsError___true_);
    return ret;
}
export function __wbindgen_cast_0000000000000002(arg0) {
    // Cast intrinsic for `F64 -> Externref`.
    const ret = arg0;
    return ret;
}
export function __wbindgen_cast_0000000000000003(arg0) {
    // Cast intrinsic for `I64 -> Externref`.
    const ret = arg0;
    return ret;
}
export function __wbindgen_cast_0000000000000004(arg0, arg1) {
    // Cast intrinsic for `Ref(String) -> Externref`.
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_cast_0000000000000005(arg0) {
    // Cast intrinsic for `U64 -> Externref`.
    const ret = BigInt.asUintN(64, arg0);
    return ret;
}
export function __wbindgen_init_externref_table() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
}
function wasm_bindgen_a8bde3ea5cc027a0___convert__closures_____invoke___wasm_bindgen_a8bde3ea5cc027a0___JsValue__core_608f92abc48d28da___result__Result_____wasm_bindgen_a8bde3ea5cc027a0___JsError___true_(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen_a8bde3ea5cc027a0___convert__closures_____invoke___wasm_bindgen_a8bde3ea5cc027a0___JsValue__core_608f92abc48d28da___result__Result_____wasm_bindgen_a8bde3ea5cc027a0___JsError___true_(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen_a8bde3ea5cc027a0___convert__closures_____invoke___js_sys_cc2eacbe17070be6___Function_fn_wasm_bindgen_a8bde3ea5cc027a0___JsValue_____wasm_bindgen_a8bde3ea5cc027a0___sys__Undefined___js_sys_cc2eacbe17070be6___Function_fn_wasm_bindgen_a8bde3ea5cc027a0___JsValue_____wasm_bindgen_a8bde3ea5cc027a0___sys__Undefined_______true_(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen_a8bde3ea5cc027a0___convert__closures_____invoke___js_sys_cc2eacbe17070be6___Function_fn_wasm_bindgen_a8bde3ea5cc027a0___JsValue_____wasm_bindgen_a8bde3ea5cc027a0___sys__Undefined___js_sys_cc2eacbe17070be6___Function_fn_wasm_bindgen_a8bde3ea5cc027a0___JsValue_____wasm_bindgen_a8bde3ea5cc027a0___sys__Undefined_______true_(arg0, arg1, arg2, arg3);
}

const PosFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_pos_free(ptr, 1));
const RangeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_range_free(ptr, 1));
const SgNodeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sgnode_free(ptr, 1));
const SgRootFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sgroot_free(ptr, 1));
const WasmEditFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmedit_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;


let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}
