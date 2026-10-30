/* oxlint-disable no-unused-expressions -- Playwright CLI requires the whole file to be a function expression. */
async (page) => {
  if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//u.test(page.url())) {
    throw new Error("report は loopback HTTP(S) で開いてください");
  }
  const expectedText = page
    .url()
    .match(/[?&]__architecture_expected_mermaid=(?<count>0|[1-9]\d*)(?:&|$)/u)
    ?.groups?.count;
  if (!expectedText) {
    throw new Error("静的 checker の期待図数を URL に指定してください");
  }
  const expected = Number(expectedText);

  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") {
      return;
    }
    const url = message.location().url || "";
    if (!url.endsWith("/favicon.ico")) {
      consoleErrors.push(message.text());
    }
  });
  await page.addInitScript(() => {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        window.__architectureInputMermaid =
          document.querySelectorAll("pre.mermaid").length;
      },
      { once: true }
    );
  });

  const response = await page.reload();
  const reloadStatus = response?.status() ?? null;
  const reloadOk = response?.ok() ?? false;
  await page.waitForFunction(
    () => Number.isInteger(window.__architectureInputMermaid),
    null,
    { timeout: 10_000 }
  );
  const inputCount = await page.evaluate(
    () => window.__architectureInputMermaid
  );
  const diagramsSettled = await page
    .waitForFunction(
      (expectedCount) => {
        const diagrams = [...document.querySelectorAll(".mermaid")];
        return (
          document.readyState === "complete" &&
          diagrams.length === expectedCount &&
          diagrams.every(
            (diagram) =>
              diagram.querySelectorAll("svg").length === 1 ||
              diagram.querySelector(
                ".error-icon, .error-text, [aria-roledescription='error'], [role='alert']"
              )
          )
        );
      },
      expected,
      { timeout: 15_000 }
    )
    .then(
      () => true,
      () => false
    );

  const result = await page.evaluate(
    ({ expectedCount, sourceDiagramCount }) => {
      const diagrams = [...document.querySelectorAll(".mermaid")];
      const diagramSvgCounts = diagrams.map(
        (diagram) => diagram.querySelectorAll("svg").length
      );
      const errorMarkers = diagrams.flatMap((diagram, index) =>
        [
          ...diagram.querySelectorAll(
            ".error-icon, .error-text, [aria-roledescription='error'], [role='alert']"
          ),
        ].map((marker) => ({
          diagram: index + 1,
          marker:
            marker.getAttribute("class") ||
            marker.getAttribute("role") ||
            marker.getAttribute("aria-roledescription"),
        }))
      );
      return {
        diagramCount: diagrams.length,
        diagramSvgCounts,
        eachDiagramHasOneSvg: diagramSvgCounts.every((count) => count === 1),
        errorMarkers,
        expectedDiagramCount: expectedCount,
        inputDiagramCount: sourceDiagramCount,
        renderedSvgCount: diagramSvgCounts.reduce(
          (sum, count) => sum + count,
          0
        ),
      };
    },
    { expectedCount: expected, sourceDiagramCount: inputCount }
  );
  result.pageErrors = pageErrors;
  result.consoleErrors = consoleErrors;
  result.reloadStatus = reloadStatus;
  result.ok =
    reloadOk &&
    diagramsSettled &&
    inputCount === expected &&
    result.diagramCount === expected &&
    result.renderedSvgCount === expected &&
    result.eachDiagramHasOneSvg &&
    result.errorMarkers.length === 0 &&
    pageErrors.length === 0 &&
    consoleErrors.length === 0;
  if (!result.ok) {
    throw new Error(
      `Mermaid 描画検査に失敗しました: ${JSON.stringify(result)}`
    );
  }
  return result;
};
