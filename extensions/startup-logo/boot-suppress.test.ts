import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
	BOOT_SUPPRESSED_KEY,
	HEADER_SUPPRESS_KEY,
	isBuiltInHeaderSuppressed,
	releaseHeaderSuppressor,
	suppressBuiltInHeader,
	suppressTarget,
} from "./boot-suppress.ts";

/**
 * 「本进程已静音」这个事实挂在 `globalThis` 上（跨扩展实例），同一个测试进程里会累积 ——
 * 每条用例从干净状态起跑，否则「还没被问过时为 false」那条会被前一条用例污染。
 */
beforeEach(() => {
	delete (globalThis as { [BOOT_SUPPRESSED_KEY]?: unknown })[BOOT_SUPPRESSED_KEY];
});

/** 仿 pi 的 `InteractiveMode`：`shouldShowStartupHeader` 是原型方法，实例自己不带。 */
class FakeInteractiveMode {
	/** 真原版被调用的次数（断言「静音期间一次都没问真原版」用）。 */
	originalCalls = 0;
	options: { verbose?: boolean };

	constructor(options: { verbose?: boolean } = {}) {
		this.options = options;
	}

	shouldShowStartupHeader(): boolean {
		this.originalCalls += 1;
		return this.options.verbose === true;
	}
}

function recordOf(): unknown {
	return (FakeInteractiveMode.prototype as { [HEADER_SUPPRESS_KEY]?: unknown })[HEADER_SUPPRESS_KEY];
}

test("静音期间内置 header 不装，解除后恢复 pi 自己的判断", () => {
	const mode = new FakeInteractiveMode();
	const release = suppressBuiltInHeader(FakeInteractiveMode);
	assert.equal(typeof release, "function");

	assert.equal(mode.shouldShowStartupHeader(), false);
	// 静音期间真原版一次都没跑 → pi 建内置 header 的那个 `if` 直接走 else 分支。
	assert.equal(mode.originalCalls, 0);

	release();
	assert.equal(mode.shouldShowStartupHeader(), false);
	assert.equal(mode.originalCalls, 1);
});

test("解除后不留接管记录，且幂等", () => {
	const release = suppressBuiltInHeader(FakeInteractiveMode)!;
	release();
	assert.equal(recordOf(), undefined);
	assert.equal(releaseHeaderSuppressor(FakeInteractiveMode), false);

	const before = FakeInteractiveMode.prototype.shouldShowStartupHeader;
	release();
	release();
	assert.equal(FakeInteractiveMode.prototype.shouldShowStartupHeader, before);
});

test("重复接管先交还上一次，不叠 wrapper", () => {
	const mode = new FakeInteractiveMode();
	const releaseFirst = suppressBuiltInHeader(FakeInteractiveMode)!;
	assert.equal(mode.shouldShowStartupHeader(), false);

	// 模拟 `/reload`：模块重新求值 → 新实例再打一次。
	const releaseSecond = suppressBuiltInHeader(FakeInteractiveMode)!;
	assert.equal(mode.shouldShowStartupHeader(), false);
	assert.equal(mode.originalCalls, 0);

	// 只解第二次：若还叠着第一层 wrapper，这里会继续返回 false 且不调真原版。
	releaseSecond();
	assert.equal(mode.shouldShowStartupHeader(), false);
	assert.equal(mode.originalCalls, 1);

	releaseFirst();
	assert.equal(mode.shouldShowStartupHeader(), false);
});

test("releaseHeaderSuppressor 能解除别的扩展实例留下的接管", () => {
	const mode = new FakeInteractiveMode();
	suppressBuiltInHeader(FakeInteractiveMode);
	assert.equal(mode.shouldShowStartupHeader(), false);

	assert.equal(releaseHeaderSuppressor(FakeInteractiveMode), true);
	assert.equal(releaseHeaderSuppressor(FakeInteractiveMode), false);
	assert.equal(mode.shouldShowStartupHeader(), false);
	assert.equal(mode.originalCalls, 1);
});

test("`--verbose` 不静音：那是用户显式要求看完整启动帮助", () => {
	const verbose = new FakeInteractiveMode({ verbose: true });
	suppressBuiltInHeader(FakeInteractiveMode);

	assert.equal(verbose.shouldShowStartupHeader(), true);
	assert.equal(verbose.originalCalls, 1);

	// 同一份补丁下，非 verbose 的实例仍然静音 —— 按实例判断，不是打补丁时定死。
	const plain = new FakeInteractiveMode();
	assert.equal(plain.shouldShowStartupHeader(), false);
	assert.equal(plain.originalCalls, 0);
});

test("`suppressed` 只在 pi 真因本补丁跳过内置 header 后为 true", () => {
	// 还没被问过：别下标认为「已经静音」（扩展要靠它决定补不补顶部空行）。
	const suppressor = suppressBuiltInHeader(FakeInteractiveMode)!;
	assert.equal(suppressor.suppressed, false);

	new FakeInteractiveMode().shouldShowStartupHeader();
	assert.equal(suppressor.suppressed, true);

	// 交还之后仍然保留「那次确实静音了」的事实 —— 补顶部空行的决定发生在 header 装上之后，
	// 而那时补丁已经交了。
	suppressor();
	assert.equal(suppressor.suppressed, true);
});

test("`suppressed` 在 verbose 下保持 false（pi 照旧自己装 header 与它的 spacer）", () => {
	const suppressor = suppressBuiltInHeader(FakeInteractiveMode)!;
	new FakeInteractiveMode({ verbose: true }).shouldShowStartupHeader();
	assert.equal(suppressor.suppressed, false);
});

test("`suppressed` 是进程级事实：/clear 之后的新扩展实例照样知道已静音", () => {
	// 用户 2026-10-22 实测回归：/clear 会重新求值扩展模块、换一个新实例，而 pi 的 init()
	// 早在旧实例的生命周期里跑完 ⇒ 新实例的 wrapper 一次都没被问过，只看本实例状态就漏掉
	// 顶部那条空行（启动正常、/clear 后印记贴顶）。事实属于进程，不属于某个实例。
	const first = suppressBuiltInHeader(FakeInteractiveMode)!;
	assert.equal(first.suppressed, false, "还没被问过：本实例 + 本进程都还没有这个事实");
	new FakeInteractiveMode().shouldShowStartupHeader();
	assert.equal(first.suppressed, true);
	assert.equal(isBuiltInHeaderSuppressed(), true, "事实应该落到进程级（globalThis）");

	// 模拟 /clear：模块重新求值 → 新实例重新打补丁，但 init() 不会再跑一次。
	const second = suppressBuiltInHeader(FakeInteractiveMode)!;
	assert.equal(second.suppressed, true, "新实例不必被问过，也能读到本进程已静音");

	// 交还补丁也不抹掉这个事实：补顶部空行的决定发生在 header 装上之后。
	second();
	assert.equal(isBuiltInHeaderSuppressed(), true);
});

test("没打过补丁的实例在干净进程里读不到「已静音」", () => {
	// `PI_LOGO=off` / `PI_LOGO_BOOT_SUPPRESS=off` 那条路压根不打补丁 ⇒ 不能凭空说有事实。
	assert.equal(isBuiltInHeaderSuppressed(), false);
	assert.equal(suppressBuiltInHeader({})?.suppressed, undefined, "形状不对时连返回值都没有");
	assert.equal(isBuiltInHeaderSuppressed(), false);
});

test("没有 options 的实例（形状不全）按非 verbose 处理，不抛错", () => {
	const bare = Object.create(FakeInteractiveMode.prototype) as {
		shouldShowStartupHeader(): boolean;
		originalCalls: number;
	};
	bare.originalCalls = 0;
	suppressBuiltInHeader(FakeInteractiveMode);
	assert.equal(bare.shouldShowStartupHeader(), false);
	assert.equal(bare.originalCalls, 0);
});

test("形状不对时什么都不做（pi 改了结构 / 传错东西）", () => {
	assert.equal(suppressBuiltInHeader(undefined), undefined);
	assert.equal(suppressBuiltInHeader(null), undefined);
	assert.equal(suppressBuiltInHeader("InteractiveMode"), undefined);
	assert.equal(suppressBuiltInHeader({}), undefined);
	assert.equal(suppressBuiltInHeader({ prototype: {} }), undefined);
	assert.equal(suppressBuiltInHeader({ prototype: { shouldShowStartupHeader: "not-a-function" } }), undefined);
});

test("直接传「带 shouldShowStartupHeader 的对象」也能接管（不要求是 class）", () => {
	const holder = {
		shouldShowStartupHeader(): boolean {
			return true;
		},
	};
	const release = suppressBuiltInHeader(holder);
	assert.equal(typeof release, "function");
	assert.equal(holder.shouldShowStartupHeader(), false);

	release();
	assert.equal(holder.shouldShowStartupHeader(), true);
	assert.equal(Object.prototype.hasOwnProperty.call(holder, "shouldShowStartupHeader"), true);
});

test("原型只读时不抛错，退回原样", () => {
	class Locked {
		shouldShowStartupHeader(): boolean {
			return true;
		}
	}
	const original = Locked.prototype.shouldShowStartupHeader;
	Object.defineProperty(Locked.prototype, "shouldShowStartupHeader", {
		value: original,
		writable: false,
		configurable: true,
	});

	const release = suppressBuiltInHeader(Locked);
	// 严格模式下写只读原型会抛 TypeError，被 catch 掉 → 按「没打上」返回 undefined。
	assert.equal(release, undefined);
	assert.equal(new Locked().shouldShowStartupHeader(), true);
});

test("suppressTarget 认得 class、原型和实例三种传法", () => {
	assert.equal(suppressTarget(FakeInteractiveMode), FakeInteractiveMode.prototype);
	assert.equal(suppressTarget(FakeInteractiveMode.prototype), FakeInteractiveMode.prototype);
	// 实例自己不带这个方法，但它从原型上能拿到 → 照样认得（不管传的是类、原型还是实例）。
	const instance = new FakeInteractiveMode();
	assert.equal(suppressTarget(instance), instance);
	// 形状对不上才是 undefined。
	assert.equal(suppressTarget({ shouldShowStartupHeader: "nope" }), undefined);
	assert.equal(suppressTarget(42), undefined);
});

test("实例自带同名方法时优先用实例的（不要求是原型）", () => {
	const instance = {
		shouldShowStartupHeader(): boolean {
			return true;
		},
	};
	const release = suppressBuiltInHeader(instance);
	assert.equal(typeof release, "function");
	assert.equal(instance.shouldShowStartupHeader(), false);

	release();
	assert.equal(instance.shouldShowStartupHeader(), true);
});
