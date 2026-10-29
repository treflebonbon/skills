# 依存関係と供給元

聞き取りと domain model の記録手順では、第三者の `grilling` と `domain-modeling` skills を使います。聞き取りを始める前に公式配布元から導入してください。`codebase-design` は module interface や seam の議論に進んだ場合だけ必要です。これらの skill はこの package に含めず、fork もしません。

現在記録されている upstream の配布元は [`mattpocock/skills` の commit `49dd158d1076134a641b33efb035946536778336`](https://github.com/mattpocock/skills/tree/49dd158d1076134a641b33efb035946536778336) です。この commit は別配布の skill の source を特定するもので、導入やコピーを行うものではありません。利用する runtime の公式導入経路を使ってください。

生成した sheet を browser で開く場合に限り、別途導入した `playwright-cli` が任意で必要です。単体で動作する HTML を作成し、file link を利用者に渡すだけなら不要です。browser 表示ができない場合は既存の代替手順を使い、file link を示して、sheet から回答を貼り付けられることを説明してください。

template、埋め込み回答 script、round-question example は [`assets/round.html`](../assets/round.html) に含まれます。HTML は network resource を使わず、build step も必要ありません。各 session の sheet は、導入済み plugin の外にある task 所有の scratch 配下へ書き込みます。
