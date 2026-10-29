# Marp Design Template

既存のテンプレートは `dracula` theme を指定する。これは Marp Core の組み込み theme ではないため、対象プロジェクトに登録済みの CSS がある場合だけ使う。見つからない場合は組み込みの `default` を選び、その他の構成はこのテンプレートに従う。

## Frontmatter

```markdown
---
marp: true
theme: dracula
paginate: true
---
```

## Slide Separator

Use `---` to separate slides.

## Basic Structure

```markdown
---
marp: true
theme: dracula
paginate: true
---

# Presentation Title

Subtitle or author name

---

## Agenda

- Topic 1
- Topic 2
- Topic 3

---

## Slide Title

- Key point 1
- Key point 2
- Key point 3

---

## Summary

- Takeaway 1
- Takeaway 2
```

## Styling Options

```markdown
<!-- _class: lead -->  # Center content
<!-- _class: invert --> # Dark background
<!-- _backgroundColor: #fff -->
<!-- _color: #333 -->
```

## Images

```markdown
![width:500px](image.png)
![bg right](background.png)
```
