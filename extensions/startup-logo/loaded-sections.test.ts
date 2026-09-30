import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DETECT_WIDTH,
	HIDDEN_SECTION_NAMES,
	SECTION_PRUNER_KEY,
	findLoadedResourcesContainer,
	hideLoadedSections,
	installHiddenSectionPruner,
	isBlankLineComponent,
	isHiddenSection,
	pruneHiddenSections,
	releaseHiddenSectionPruner,
	sectionTitleOfLine,
} from "./loaded-sections.ts";

/** 最小可用的假组件 / 假容器：形状照着 pi-tui 的 Container / Text / Spacer 来。 */
class FakeSection {
	name: string;
	constructor(name: string) {
		this.name = name;
	}
	render(_width: number): string[] {
		return [`\u001b[38;2;121;214;193m[${this.name}]\u001b[39m`, `  ${this.name} 的内容`, ""];
	}
}

class FakeSpacer {
	render(_width: number): string[] {
		return [""];
	}
}

class FakeText {
	text: string;
	constructor(text: string) {
		this.text = text;
	}
	render(_width: number): string[] {
		// pi-tui 的 Text 对空串返回空数组（不是 [""]），这里照抄这个细节
		return this.text ? [this.text] : [];
	}
}

class FakeContainer {
	children: unknown[] = [];
	addChild(child: unknown): void {
		this.children.push(child);
	}
	render(width: number): string[] {
		return this.children.flatMap((child) => (child as { render(w: number): string[] }).render(width));
	}
}

/** 照 `showLoadedResources` 的顺序把一整份清单填进容器。 */
function fillLoadedResources(container: FakeContainer, names: readonly string[] = ["Context", "Skills", "Prompts", "Extensions"]): void {
	container.addChild(new FakeSpacer()); // [Context] 前面那个额外空行
	for (const name of names) {
		container.addChild(new FakeSection(name));
		container.addChild(new FakeSpacer());
	}
}

const titlesIn = (container: FakeContainer): string[] =>
	container.children
		.map((child) => sectionTitleOfLine((child as FakeSection).render(80)[0]))
		.filter((title): title is string => title !== undefined);

test("sectionTitleOfLine：只认 `[Name]` 整行，ANSI 不参与", () => {
	assert.equal(sectionTitleOfLine("\u001b[36m[Context]\u001b[39m"), "Context");
	assert.equal(sectionTitleOfLine("  [Prompts]  "), "Prompts");
	assert.equal(sectionTitleOfLine("[Skill conflicts]"), "Skill conflicts");
	assert.equal(sectionTitleOfLine("[Context] 三个文件"), undefined);
	assert.equal(sectionTitleOfLine("[[Context]]"), undefined);
	assert.equal(sectionTitleOfLine(""), undefined);
	assert.equal(sectionTitleOfLine(undefined), undefined);
	assert.equal(sectionTitleOfLine(42), undefined);
});

test("isHiddenSection / isBlankLineComponent：只看第一行，渲染抛错只当「不是」", () => {
	assert.equal(isHiddenSection(new FakeSection("Context")), true);
	assert.equal(isHiddenSection(new FakeSection("Prompts")), true);
	assert.equal(isHiddenSection(new FakeSection("Themes")), true);
	assert.equal(isHiddenSection(new FakeSection("Extensions")), true);
	assert.equal(isHiddenSection(new FakeSection("Skills")), true);
	// 诊断段不在名单里：它们才是这份清单剪完之后唯一还可能出现的东西
	assert.equal(isHiddenSection(new FakeSection("Skill conflicts")), false);
	assert.equal(isHiddenSection(new FakeSection("Extension issues")), false);
	assert.equal(isHiddenSection(new FakeSpacer()), false);
	assert.equal(isHiddenSection({ render: () => [{}, "x"] }), false);
	assert.equal(
		isHiddenSection({
			render: () => {
				throw new Error("boom");
			},
		}),
		false,
	);
	assert.equal(isHiddenSection(undefined), false);
	assert.equal(isBlankLineComponent(new FakeSpacer()), true);
	assert.equal(isBlankLineComponent(new FakeText("")), false, "空 Text 渲染出 []，不是 spacer 形状");
	assert.equal(isBlankLineComponent(new FakeSection("Skills")), false);
	assert.equal(isBlankLineComponent({ render: () => [""] }), true);
});

test("addChild 接管：整份清单一段都进不去，连 `[Context]` 前面那个额外空行也收掉", () => {
	const container = new FakeContainer();
	assert.equal(installHiddenSectionPruner({ container }) !== undefined, true);
	fillLoadedResources(container);

	assert.deepEqual(titlesIn(container), []);
	assert.equal(container.children.length, 0, "清单全剪完之后容器应该是空的，不留一行多余留白");
});

test("addChild 接管：诊断段照常放行，它前面的空行也不动", () => {
	const container = new FakeContainer();
	installHiddenSectionPruner({ container });
	container.addChild(new FakeSection("Context"));
	container.addChild(new FakeSpacer());
	container.addChild(new FakeSection("Skill conflicts"));
	container.addChild(new FakeSpacer());
	assert.deepEqual(titlesIn(container), ["Skill conflicts"]);
	assert.equal(container.children.length, 2);
});

test("addChild 接管：只在「容器里恰好剩这一个空行」时才收掉前置空行", () => {
	const container = new FakeContainer();
	installHiddenSectionPruner({ container });
	// 保留段 + 它自己的分隔空行先落地，随后一个被剪的段进来
	container.addChild(new FakeSection("Skill conflicts"));
	container.addChild(new FakeSpacer());
	container.addChild(new FakeSection("Context"));
	// 那个空行是保留段的分隔空行，不是「清单开头那一个」，不能被顺手删掉
	assert.deepEqual(titlesIn(container), ["Skill conflicts"]);
	assert.equal(container.children.length, 2);
	assert.equal(container.children[1] instanceof FakeSpacer, true);
});

test("addChild 接管：非 `[x]` 形状、渲染抛错、非对象的 child 一律放行", () => {
	const container = new FakeContainer();
	installHiddenSectionPruner({ container });
	const throwing = {
		render: () => {
			throw new Error("boom");
		},
	};
	const plainText = new FakeText("[Context] 这三个文件");
	container.addChild(throwing);
	container.addChild(plainText);
	container.addChild("裸字符串");
	container.addChild(new FakeText(""));
	assert.deepEqual(container.children, [throwing, plainText, "裸字符串", container.children[3]]);
});

test("addChild 接管：只有被剪掉的段才吃后面的空行，普通段后面照常", () => {
	const container = new FakeContainer();
	installHiddenSectionPruner({ container });
	container.addChild(new FakeSection("Skill conflicts"));
	container.addChild(new FakeSpacer());
	container.addChild(new FakeSection("Prompts"));
	container.addChild(new FakeSpacer());
	container.addChild(new FakeSection("Extensions"));
	assert.deepEqual(titlesIn(container), ["Skill conflicts"]);
	assert.equal(container.children.length, 2);
});

test("pruneHiddenSections：装晚了（清单已填好）也能剪干净", () => {
	const container = new FakeContainer();
	fillLoadedResources(container);
	assert.equal(container.children.length, 9); // 1 + 4×2
	assert.equal(pruneHiddenSections(container), 4);
	assert.deepEqual(titlesIn(container), []);
	assert.equal(container.children.length, 0, "开头那个额外空行也一起收掉");
});

test("pruneHiddenSections：没有任何隐藏段时原样返回 0", () => {
	const container = new FakeContainer();
	fillLoadedResources(container, ["Skill conflicts"]);
	const before = [...container.children];
	assert.equal(pruneHiddenSections(container), 0);
	assert.deepEqual(container.children, before);
	assert.equal(pruneHiddenSections(undefined), 0);
	assert.equal(pruneHiddenSections({}), 0);
});

test("installHiddenSectionPruner：装晚了先剪一遍已有内容，之后新加的也进不去", () => {
	const container = new FakeContainer();
	fillLoadedResources(container);
	installHiddenSectionPruner({ container });
	assert.deepEqual(titlesIn(container), []);
	// /reload：clear() 之后重新填一份清单
	container.children = [];
	container.addChild(new FakeSpacer());
	container.addChild(new FakeSection("Context"));
	container.addChild(new FakeSpacer());
	container.addChild(new FakeSection("Skills"));
	container.addChild(new FakeSpacer());
	container.addChild(new FakeSection("Extension issues"));
	assert.deepEqual(titlesIn(container), ["Extension issues"]);
});

test("接管幂等：重复安装不叠 wrapper，旧 release 不拆新 wrapper，release 后恢复原状", () => {
	const container = new FakeContainer();
	const release1 = installHiddenSectionPruner({ container });
	assert.equal(typeof release1, "function");
	const release2 = installHiddenSectionPruner({ container });
	assert.equal(typeof release2, "function");

	// 第二次安装已经顶掉了第一次：再调旧 release 也不能把新 wrapper 拆掉
	release1!();
	container.addChild(new FakeSection("Context"));
	assert.deepEqual(titlesIn(container), [], "旧 release 不应动到新接管");

	assert.equal(releaseHiddenSectionPruner(container), true);
	release2!();
	assert.equal(releaseHiddenSectionPruner(container), false);

	// 解除之后新加的段不再被剪（等价于 pi-tui Container 的原始 addChild）
	container.addChild(new FakeSection("Context"));
	assert.deepEqual(titlesIn(container), ["Context"]);
});

test("接管记录挂在符号键上：别的实例能解除旧的接管", () => {
	const container = new FakeContainer();
	installHiddenSectionPruner({ container });
	assert.equal(typeof (container as { [SECTION_PRUNER_KEY]?: unknown })[SECTION_PRUNER_KEY], "object");
	// 模拟 /reload：新实例只拿到容器对象也要能清掉旧 wrapper
	assert.equal(releaseHiddenSectionPruner(container), true);
	assert.equal((container as { [SECTION_PRUNER_KEY]?: unknown })[SECTION_PRUNER_KEY], undefined);
	const container2 = new FakeContainer();
	assert.equal(releaseHiddenSectionPruner(container2), false);
});

test("findLoadedResourcesContainer：按 header 容器的下一个兄弟容器认，认不出返回 undefined", () => {
	const headerContainer = new FakeContainer();
	const loadedResources = new FakeContainer();
	const chatContainer = new FakeContainer();
	const document = new FakeContainer();
	document.addChild(headerContainer);
	document.addChild(loadedResources);
	document.addChild(chatContainer);
	const root = { children: [document] };

	assert.equal(findLoadedResourcesContainer({ root, headerContainer }), loadedResources);
	// header 容器自己不在树里 → 认不出
	assert.equal(findLoadedResourcesContainer({ root, headerContainer: new FakeContainer() }), undefined);
	assert.equal(findLoadedResourcesContainer({ root, headerContainer: undefined }), undefined);
	// 兄弟不是容器形状 → 认不出
	const oddHeader = new FakeContainer();
	const oddDocument = new FakeContainer();
	oddDocument.addChild(oddHeader);
	oddDocument.addChild({ 不是容器: true });
	assert.equal(findLoadedResourcesContainer({ root: { children: [oddDocument] }, headerContainer: oddHeader }), undefined);
});

test("hideLoadedSections：整条链路（找容器 → 接管 → 填清单）", () => {
	const headerContainer = new FakeContainer();
	const loadedResources = new FakeContainer();
	const document = new FakeContainer();
	document.addChild(headerContainer);
	document.addChild(loadedResources);
	const root = { children: [document] };

	assert.equal(hideLoadedSections({ root, headerContainer }), true);
	fillLoadedResources(loadedResources);
	assert.deepEqual(titlesIn(loadedResources), []);

	// 找不到容器时返回 false，什么都不改
	assert.equal(hideLoadedSections({ root, headerContainer: new FakeContainer() }), false);
	// 自定义隐藏名单
	const other = new FakeContainer();
	const otherHeader = new FakeContainer();
	const otherDocument = new FakeContainer();
	otherDocument.addChild(otherHeader);
	otherDocument.addChild(other);
	assert.equal(hideLoadedSections({ root: { children: [otherDocument] }, headerContainer: otherHeader, names: ["Context"] }), true);
	fillLoadedResources(other);
	assert.deepEqual(titlesIn(other), ["Skills", "Prompts", "Extensions"]);
});

test("默认隐藏名单就是清单那几段（含 Skills），判定宽度是个常规值", () => {
	assert.deepEqual(HIDDEN_SECTION_NAMES, ["Context", "Skills", "Prompts", "Extensions", "Themes"]);
	assert.ok(DETECT_WIDTH >= 80, "标题行 `[Context]` 只有 9 列，判定宽度够宽就行");
});
