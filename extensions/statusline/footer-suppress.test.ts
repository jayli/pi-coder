import assert from "node:assert/strict";
import { test } from "node:test";
import {
	FOOTER_SUPPRESS_KEY,
	FOOTER_SUPPRESS_MAX_AGE_MS,
	releaseFooterSuppressor,
	suppressBuiltInFooter,
} from "./footer-suppress.ts";

/** 仿 pi 的 `FooterComponent`：render 是原型方法，实例自己不带 render。 */
class FakeFooter {
	/** 真原版被调用的次数（断言「屏蔽期间一帧都没出真内容」用）。 */
	originalRenders = 0;

	render(width: number): string[] {
		this.originalRenders += 1;
		return [`pi-default#${width}`, `stats#${width}`];
	}
}

function recordOf(): unknown {
	return (FakeFooter.prototype as { [FOOTER_SUPPRESS_KEY]?: unknown })[FOOTER_SUPPRESS_KEY];
}

test("屏蔽期间内置 footer 渲染 0 行，解除后恢复原渲染", () => {
	const footer = new FakeFooter();
	const release = suppressBuiltInFooter(FakeFooter);
	assert.equal(typeof release, "function");

	assert.deepEqual(footer.render(80), []);
	assert.deepEqual(footer.render(40), []);
	// 屏蔽期间真原版一次都没跑 → 屏幕上不会出现默认状态行。
	assert.equal(footer.originalRenders, 0);

	release();
	assert.deepEqual(footer.render(80), ["pi-default#80", "stats#80"]);
	assert.equal(footer.originalRenders, 1);
});

test("解除后不留接管记录，且幂等", () => {
	const release = suppressBuiltInFooter(FakeFooter)!;
	release();
	assert.equal(recordOf(), undefined);
	assert.equal(releaseFooterSuppressor(FakeFooter), false);

	// 重复解除不再改动任何东西（原型方法还是那个真原版）。
	const before = FakeFooter.prototype.render;
	release();
	release();
	assert.equal(FakeFooter.prototype.render, before);
	assert.deepEqual(new FakeFooter().render(5), ["pi-default#5", "stats#5"]);
});

test("重复接管先交还上一次，不叠 wrapper", () => {
	const footer = new FakeFooter();
	const releaseFirst = suppressBuiltInFooter(FakeFooter)!;
	assert.deepEqual(footer.render(10), []);

	// 模拟 `/reload`：模块重新求值 → 新实例再打一次。
	const releaseSecond = suppressBuiltInFooter(FakeFooter)!;
	assert.deepEqual(footer.render(10), []);
	assert.equal(footer.originalRenders, 0);

	// 只解第二次：若还叠着第一层 wrapper，这里会继续出空行。
	releaseSecond();
	assert.deepEqual(footer.render(10), ["pi-default#10", "stats#10"]);
	assert.equal(footer.originalRenders, 1);

	releaseFirst();
	assert.deepEqual(footer.render(10), ["pi-default#10", "stats#10"]);
});

test("releaseFooterSuppressor 能解除别的扩展实例留下的接管", () => {
	suppressBuiltInFooter(FakeFooter);
	assert.equal(new FakeFooter().render(7).length, 0);

	assert.equal(releaseFooterSuppressor(FakeFooter), true);
	assert.equal(releaseFooterSuppressor(FakeFooter), false);
	assert.deepEqual(new FakeFooter().render(7), ["pi-default#7", "stats#7"]);
});

test("超时后自愈：交还原渲染并清掉接管记录", () => {
	let clock = 1000;
	const footer = new FakeFooter();
	suppressBuiltInFooter(FakeFooter, { maxAgeMs: 500, now: () => clock });
	assert.deepEqual(footer.render(9), []);

	// 还没到点：仍然屏蔽。
	clock = 1500;
	assert.deepEqual(footer.render(9), []);

	// 过点：自动交还，后面几帧都走真原版。
	clock = 1501;
	assert.deepEqual(footer.render(9), ["pi-default#9", "stats#9"]);
	assert.equal(recordOf(), undefined);
	assert.deepEqual(footer.render(9), ["pi-default#9", "stats#9"]);
});

test("默认兜底时长能盖住慢启动（`mcp` 连 server 的那段等待），且是个正数", () => {
	assert.ok(FOOTER_SUPPRESS_MAX_AGE_MS >= 25_000);
});

test("形状不对时什么都不做（pi 改了结构 / 传错东西）", () => {
	assert.equal(suppressBuiltInFooter(undefined), undefined);
	assert.equal(suppressBuiltInFooter(null), undefined);
	assert.equal(suppressBuiltInFooter("FooterComponent"), undefined);
	assert.equal(suppressBuiltInFooter({}), undefined);
	assert.equal(suppressBuiltInFooter({ prototype: {} }), undefined);
	assert.equal(suppressBuiltInFooter({ prototype: { render: "not-a-function" } }), undefined);
});

test("直接传「带 render 的对象」也能接管（不要求是 class）", () => {
	const component = {
		render(width: number): string[] {
			return [`raw#${width}`];
		},
	};
	const release = suppressBuiltInFooter(component);
	assert.equal(typeof release, "function");
	assert.deepEqual(component.render(3), []);

	release();
	assert.deepEqual(component.render(3), ["raw#3"]);
	assert.equal(Object.prototype.hasOwnProperty.call(component, "render"), true);
});

test("原型只读时不抛错，退回原样", () => {
	class Locked {
		render(): string[] {
			return ["locked"];
		}
	}
	Object.defineProperty(Locked.prototype, "render", {
		configurable: false,
		writable: false,
		value: () => ["locked"],
	});

	assert.equal(suppressBuiltInFooter(Locked), undefined);
	assert.deepEqual(new Locked().render(), ["locked"]);
});

test("wrapper 的 this 透传给真原版（实例状态照常读写）", () => {
	const footer = new FakeFooter();
	const release = suppressBuiltInFooter(FakeFooter)!;
	assert.deepEqual(footer.render(80), []);
	release();
	assert.deepEqual(footer.render(80), ["pi-default#80", "stats#80"]);
	assert.equal(footer.originalRenders, 1);
});
