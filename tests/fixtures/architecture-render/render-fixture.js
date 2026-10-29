const script = document.createElement("script");
script.src = "/mermaid.min.js";
script.addEventListener("load", async () => {
  mermaid.initialize({
    securityLevel: "strict",
    startOnLoad: false,
    theme: "neutral",
  });
  try {
    await mermaid.run();
  } catch (error) {
    if (
      !["/original-error.html", "/invalid-syntax.html"].includes(
        location.pathname
      )
    ) {
      throw error;
    }
  }
  if (location.pathname === "/two-svgs.html") {
    const svg = document.querySelector(".mermaid svg");
    svg.after(svg.cloneNode(true));
  }
});
script.addEventListener("error", () =>
  console.error("Mermaid 11.17.2 failed to load")
);
document.head.append(script);
