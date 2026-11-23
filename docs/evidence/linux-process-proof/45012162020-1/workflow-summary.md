# Linux 追加実証

判定: 成功条件未達

source: c6947cda6fc5dada4e021cfc87034133393da8cb
workflow: 86b52f3b755771d190728f5e38659c2f022bf0b7
run/attempt: 45012162020/1

- x64: artifact の同一性・保存期間を確認できません
- arm64: artifact の同一性・保存期間を確認できません
- 同じ SHA の失敗履歴を確認できません
- metadata: Error: public metadata API: HTTP 403 /actions/runs/45012162020 x-ratelimit-limit=60 x-ratelimit-remaining=0 x-ratelimit-reset=1795344012 {"message":"API rate limit exceeded for 3.42.157.50. (But here's the good news: Authenticated requests get a higher rate limit. Check out the documentation for more details.)","documentation_url":"https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting"} 

#33 は OPEN、#82 は #33 待ち、macOS 移行は保留。JSON と要約は人が確認したうえで Git 管理へ移す。
