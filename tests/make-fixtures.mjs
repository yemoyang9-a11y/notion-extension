/* Generates the synthetic fixtures. Real-site snapshots are added with
   tests/snapshot.mjs; these cover the structures known to break clippers. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pages = path.join(here, "pages");

const shell = (title, body, extraHead = "") => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>
<meta property="og:title" content="${title}"><meta property="og:image" content="https://example.com/cover.png">${extraHead}</head>
<body><header class="site-header"><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
<main>${body}</main>
<footer class="site-footer"><p>© Example. All rights reserved.</p></footer></body></html>`;

const lorem = (n) => Array.from({ length: n }, (_, i) => `<p>문단 ${i + 1}. 이 문장은 본문을 채우기 위한 일반적인 설명 문장이며 클리퍼가 본문으로 인식할 만큼 충분히 길게 작성되어 있습니다. Sentence ${i + 1} of the article body, long enough to count as content.</p>`).join("\n");

const fixtures = {
  "code-br-and-gutters": {
    url: "https://blog.example.com/posts/code-br",
    html: shell("코드블록: br 줄바꿈과 줄번호", `<article>
<h1>코드블록: br 줄바꿈과 줄번호</h1>
${lorem(3)}
<h2>br로 줄을 나눈 코드</h2>
<pre class="brush: python">def foo():<br>    return 1<br><br>print(foo())</pre>
<h2>Pygments 줄번호 (Sphinx)</h2>
<div class="highlight"><pre><span class="linenos">1</span><span class="k">import</span> <span class="nn">os</span>
<span class="linenos">2</span><span class="nb">print</span><span class="p">(</span><span class="n">os</span><span class="o">.</span><span class="n">getcwd</span><span class="p">())</span>
</pre></div>
<h2>Chroma (Hugo) 줄번호</h2>
<div class="highlight"><pre tabindex="0" class="chroma"><code class="language-go" data-lang="go"><span class="line"><span class="ln">1</span><span class="cl"><span class="kn">package</span> <span class="nx">main</span>
</span></span><span class="line"><span class="ln">2</span><span class="cl"><span class="kn">import</span> <span class="s">&quot;fmt&quot;</span>
</span></span><span class="line"><span class="ln">3</span><span class="cl"><span class="kd">func</span> <span class="nf">main</span><span class="p">()</span> <span class="p">{</span> <span class="nx">fmt</span><span class="p">.</span><span class="nf">Println</span><span class="p">(</span><span class="s">&quot;hi&quot;</span><span class="p">)</span> <span class="p">}</span>
</span></span></code></pre></div>
<h2>Rouge (Jekyll) 테이블 줄번호</h2>
<figure class="highlight"><pre><code class="language-ruby" data-lang="ruby"><table class="rouge-table"><tbody><tr><td class="rouge-gutter gl"><pre class="lineno">1
2
</pre></td><td class="rouge-code"><pre><span class="k">def</span> <span class="nf">hello</span>
  <span class="nb">puts</span> <span class="s2">"hi"</span>
</pre></td></tr></tbody></table></code></pre></figure>
<h2>hljs-ln 테이블</h2>
<pre><code class="hljs language-javascript"><table class="hljs-ln"><tbody><tr><td class="hljs-ln-numbers"><div class="hljs-ln-n" data-line-number="1"></div></td><td class="hljs-ln-code"><div class="hljs-ln-line">const a = 1;</div></td></tr><tr><td class="hljs-ln-numbers"><div class="hljs-ln-n" data-line-number="2"></div></td><td class="hljs-ln-code"><div class="hljs-ln-line">console.log(a);</div></td></tr></tbody></table></code></pre>
${lorem(2)}
</article>`),
    expected: {
      blocks: [
        { type: "heading_1" },
        { type: "code", includes: ["def foo():\n    return 1\n\nprint(foo())"], language: "python" },
        { type: "code", includes: ["import os\nprint(os.getcwd())"], excludes: ["1import", "2print"] },
        { type: "code", language: "go", includes: ["package main\nimport \"fmt\"\nfunc main()"], excludes: ["1package"] },
        { type: "code", language: "ruby", includes: ["def hello\n  puts \"hi\""], excludes: ["1\n2"] },
        { type: "code", language: "javascript", includes: ["const a = 1;\nconsole.log(a);"] },
      ],
      excludesText: ["Home About"],
    },
  },

  "code-shiki-prism-copy": {
    url: "https://docs.example.com/guide/install",
    html: shell("설치 가이드", `<article class="markdown-body">
<h1>설치 가이드</h1>
${lorem(3)}
<div data-rehype-pretty-code-fragment><div data-rehype-pretty-code-title>package.json</div><button class="copy-button">Copy</button>
<pre class="shiki github-dark" data-language="json" data-theme="github-dark"><code data-line-numbers><span data-line><span style="color:#E1E4E8">{</span></span>
<span data-line><span style="color:#79B8FF">  "name"</span><span style="color:#E1E4E8">: </span><span style="color:#9ECBFF">"intact"</span></span>
<span data-line><span style="color:#E1E4E8">}</span></span></code></pre></div>
<h2>Prism line-numbers</h2>
<pre class="language-bash line-numbers"><code class="language-bash">npm install
npm run build<span aria-hidden="true" class="line-numbers-rows"><span></span><span></span></span></code></pre>
<h2>Docusaurus</h2>
<div class="codeBlockContainer_Ckt0 theme-code-block" style="--prism-color:#393A34"><div class="codeBlockContent_biex"><pre tabindex="0" class="prism-code language-tsx codeBlock_bY9V thin-scrollbar"><code class="codeBlockLines_e6Vv"><span class="token-line"><span class="token keyword">export</span><span class="token plain"> </span><span class="token keyword">default</span><span class="token plain"> </span><span class="token function">App</span><span class="token plain">;</span><br></span><span class="token-line"><span class="token plain">// end</span><br></span></code></pre><div class="buttonGroup__atx"><button type="button" aria-label="Copy code to clipboard" title="Copy" class="clean-btn"><span class="copyButtonIcons_eSgA" aria-hidden="true">Copy</span></button></div></div></div>
${lorem(2)}
</article>`),
    expected: {
      blocks: [
        { type: "code", language: "json", includes: ["{\n  \"name\": \"intact\"\n}"], excludes: ["Copy", "package.json"] },
        { type: "code", language: "shell", includes: ["npm install\nnpm run build"] },
        { type: "code", language: "typescript", includes: ["export default App;\n// end"], excludes: ["Copy"] },
      ],
    },
  },

  "tistory-colorscripter": {
    url: "https://devlog.tistory.com/123",
    html: shell("티스토리 글", `<div id="content"><div class="inner"><article id="article-view" class="tt_article_useless_p_margin contents_style">
<h1 class="tit_post">티스토리 글</h1>
${lorem(3)}
<pre class="kotlin" data-ke-language="kotlin"><code>fun main() {
    println("hello")
}</code></pre>
<p data-ke-size="size16">아래는 ColorScripter로 넣은 코드입니다. 표 형태로 렌더링됩니다.</p>
<div class="colorscripter-code" style="color:#010101;font-family:Consolas;font-size:13px;border:1px solid #d6d6d6;padding:16px;" data-codetype="Python"><table class="colorscripter-code-table" style="margin:0;padding:0;border:none;background-color:#fafafa;" cellspacing="0" cellpadding="0"><tbody><tr><td style="padding:6px;border-right:2px solid #e5e5e5"><div style="margin:0;padding:0;word-break:normal;text-align:right;color:#666;font-family:Consolas;line-height:130%"><div style="line-height:130%">1</div><div style="line-height:130%">2</div><div style="line-height:130%">3</div></div></td><td style="padding:6px 0;text-align:left"><div style="margin:0;padding:0;color:#010101;font-family:Consolas;line-height:130%"><div style="padding:0 6px; white-space:pre; line-height:130%"><span style="color:#ff3399">import</span>&nbsp;<span style="color:#010101">json</span></div><div style="padding:0 6px; white-space:pre; line-height:130%">&nbsp;</div><div style="padding:0 6px; white-space:pre; line-height:130%"><span style="color:#010101">data&nbsp;=&nbsp;json.loads(</span><span style="color:#ffd500">"{}"</span><span style="color:#010101">)</span></div></div></td><td style="vertical-align:bottom;padding:0 2px 4px 0"><a href="http://colorscripter.com/info#e" target="_blank" style="color:#e5e5e5text-decoration:none">Colored by Color Scripter</a></td></tr></tbody></table></div>
<figure class="imageblock alignCenter" data-ke-mobileStyle="widthOrigin" data-origin-width="1200" data-origin-height="800"><span data-url="https://blog.kakaocdn.net/dn/abc123/btrXYZ/img.png" data-phocus="https://blog.kakaocdn.net/dn/abc123/btrXYZ/img.png"><img src="https://blog.kakaocdn.net/dn/abc123/btrXYZ/img.png" srcset="https://img1.daumcdn.net/thumb/R1280x0/?scode=mtistory2&amp;fname=https%3A%2F%2Fblog.kakaocdn.net%2Fdn%2Fabc123%2FbtrXYZ%2Fimg.png" width="1200" height="800" data-filename="img.png" data-origin-width="1200" data-origin-height="800"></span><figcaption>다이어그램</figcaption></figure>
${lorem(2)}
</article></div></div>`),
    expected: {
      blocks: [
        { type: "code", language: "kotlin", includes: ["fun main() {\n    println(\"hello\")\n}"] },
        { type: "code", language: "python", includes: ["import json\n\ndata = json.loads(\"{}\")"], excludes: ["Colored by", "1\n2\n3"] },
        { type: "image", includes: ["blog.kakaocdn.net/dn/abc123/btrXYZ/img.png"] },
      ],
      excludesText: ["Colored by Color Scripter"],
    },
  },

  "naver-smarteditor": {
    url: "https://blog.naver.com/PostView.naver?blogId=yemo&logNo=223000000001",
    html: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>네이버 블로그 글 : 네이버 블로그</title></head><body>
<div id="post-area"><div class="se-viewer se-theme-default"><div class="se-main-container">
<div class="se-component se-documentTitle se-l-default"><div class="se-component-content"><div class="se-section se-section-documentTitle"><div class="se-module se-module-text se-title-text"><p class="se-text-paragraph"><span class="se-fs-fs32">네이버 블로그 글 제목</span></p></div></div></div></div>
<div class="se-component se-text se-l-default"><div class="se-component-content"><div class="se-section se-section-text"><div class="se-module se-module-text"><p class="se-text-paragraph se-text-paragraph-align-"><span class="se-fs- se-ff-nanumgothic">첫 번째 문단입니다. 스마트에디터 ONE으로 작성한 글이며 본문 인식이 되어야 합니다. 조금 더 길게 써서 본문으로 잡히도록 합니다.</span></p><p class="se-text-paragraph"><span class="se-fs- se-ff-nanumgothic" style="font-weight:bold">굵은 두 번째 문단</span><span class="se-fs- se-ff-nanumgothic">과 일반 텍스트가 섞여 있습니다.</span></p><p class="se-text-paragraph"><span>&nbsp;</span></p></div></div></div></div>
<div class="se-component se-sectionTitle se-l-default"><div class="se-component-content"><div class="se-section se-section-sectionTitle"><div class="se-module se-module-text"><p class="se-text-paragraph"><span class="se-fs-fs19">소제목 하나</span></p></div></div></div></div>
<div class="se-component se-code se-l-default"><div class="se-component-content"><div class="se-section se-section-code"><div class="se-module se-module-code"><div class="se-code-source"><pre><code>SELECT *<br>FROM users<br>WHERE id = 1;</code></pre></div></div></div></div></div>
<div class="se-component se-image se-l-default"><div class="se-component-content"><div class="se-section se-section-image"><div class="se-module se-module-image"><a class="se-module-image-link __se_image_link"><img src="" data-lazy-src="https://postfiles.pstatic.net/MjAyNjA5/abc/IMG_0001.jpg?type=w773" class="se-image-resource" alt="사진"></a></div><div class="se-module se-module-text se-caption"><p class="se-text-paragraph"><span>사진 설명</span></p></div></div></div></div>
<div class="se-component se-quotation se-l-quotation_line"><div class="se-component-content"><div class="se-section se-section-quotation"><div class="se-module se-module-text se-quote"><p class="se-text-paragraph"><span>인용문 내용입니다.</span></p></div><div class="se-module se-module-text se-cite"><p class="se-text-paragraph"><span>출처</span></p></div></div></div></div>
<div class="se-component se-oglink se-l-large_image"><div class="se-component-content"><div class="se-section se-section-oglink"><div class="se-module se-module-oglink"><a href="https://developers.notion.com/reference/block" class="se-oglink-info" target="_blank"><div class="se-oglink-info-container"><strong class="se-oglink-title">Block – Notion API</strong><p class="se-oglink-summary">블록 레퍼런스</p><p class="se-oglink-url">developers.notion.com</p></div></a></div></div></div></div>
<div class="se-component se-table se-l-default"><div class="se-component-content"><div class="se-section se-section-table"><div class="se-module se-module-table"><table class="se-table-content"><tbody><tr class="se-tr"><td class="se-cell"><div class="se-module se-module-text"><p class="se-text-paragraph"><span>이름</span></p></div></td><td class="se-cell"><div class="se-module se-module-text"><p class="se-text-paragraph"><span>값</span></p></div></td></tr><tr class="se-tr"><td class="se-cell"><div class="se-module se-module-text"><p class="se-text-paragraph"><span>a</span></p></div></td><td class="se-cell"><div class="se-module se-module-text"><p class="se-text-paragraph"><span>1</span></p></div></td></tr></tbody></table></div></div></div></div>
<div class="se-component se-horizontalLine se-l-default"><div class="se-component-content"><div class="se-section se-section-horizontalLine"><hr class="se-hr"></div></div></div>
<div class="se-component se-sticker se-l-default"><div class="se-component-content"><img src="https://storep-phinf.pstatic.net/sticker.png"></div></div>
</div></div></div>
<div class="post_footer_contents"><a href="#">공감</a><a href="#">댓글</a><a href="#">공유하기</a></div>
</body></html>`,
    expected: {
      via: "site-handler",
      blocks: [
        { type: "paragraph", includes: ["첫 번째 문단"] },
        { type: "paragraph", includes: ["굵은 두 번째 문단"] },
        { type: "heading_2", includes: ["소제목 하나"] },
        { type: "code", includes: ["SELECT *\nFROM users\nWHERE id = 1;"] },
        { type: "image", includes: ["postfiles.pstatic.net/MjAyNjA5/abc/IMG_0001.jpg?type=w2000"] },
        { type: "quote", includes: ["인용문 내용입니다."] },
        { type: "bookmark", includes: ["developers.notion.com/reference/block"] },
        { type: "table", width: 2, rows: 2 },
        { type: "divider" },
      ],
      excludesText: ["공유하기", "sticker.png"],
    },
  },

  "math-katex-mathjax2-wiki": {
    url: "https://math.example.com/notes/eigen",
    html: shell("고유값 노트", `<article>
<h1>고유값 노트</h1>
${lorem(3)}
<p>인라인 수식 <span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>A</mi><mi>v</mi><mo>=</mo><mi>λ</mi><mi>v</mi></mrow><annotation encoding="application/x-tex">Av = \\lambda v</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base">Av=λv</span></span></span> 가 있습니다.</p>
<span class="katex-display"><span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mi>det</mi><mo>(</mo><mi>A</mi><mo>−</mo><mi>λ</mi><mi>I</mi><mo>)</mo><mo>=</mo><mn>0</mn></mrow><annotation encoding="application/x-tex">\\det(A - \\lambda I) = 0</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">det(A−λI)=0</span></span></span>
<p>MathJax v2: <span class="MathJax_Preview"></span><span class="MathJax" id="MathJax-Element-1-Frame" role="presentation"><span class="math"><span>x^2</span></span></span><script type="math/tex" id="MathJax-Element-1">x^2 + y^2 = z^2</script> 끝.</p>
<div class="MathJax_Display"><span class="MathJax" role="presentation">∑</span></div><script type="math/tex; mode=display">\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}</script>
<p>위키백과 방식: <span class="mwe-math-element"><span class="mwe-math-mathml-inline mwe-math-mathml-a11y" style="display: none;"><math xmlns="http://www.w3.org/1998/Math/MathML" alttext="{\\displaystyle e^{i\\pi }+1=0}"><semantics><mrow></mrow></semantics></math></span><img src="https://wikimedia.org/api/rest_v1/media/math/render/svg/abc" class="mwe-math-fallback-image-inline" aria-hidden="true" alt="{\\displaystyle e^{i\\pi }+1=0}"></span> 오일러.</p>
${lorem(2)}
</article>`),
    expected: {
      blocks: [
        { type: "paragraph", includes: ["Av = \\lambda v"] },
        { type: "equation", equals: "\\det(A - \\lambda I) = 0" },
        { type: "paragraph", includes: ["x^2 + y^2 = z^2"] },
        { type: "equation", includes: ["\\sum_{i=1}^{n}"] },
        { type: "paragraph", includes: ["e^{i\\pi }+1=0"] },
      ],
    },
  },

  "math-selection-path": {
    url: "https://math.example.com/notes/eigen-selection",
    selection: "article",
    html: shell("선택 영역 수식", `<article>
<h1>선택 영역 수식</h1>
${lorem(2)}
<p>인라인 <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>a</mi></mrow><annotation encoding="application/x-tex">a^2+b^2=c^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">a²+b²=c²</span></span> 피타고라스.</p>
<pre class="language-python"><code class="language-python"><span class="token keyword">def</span> f<span class="token punctuation">(</span>x<span class="token punctuation">)</span><span class="token punctuation">:</span>
    <span class="token keyword">return</span> x<span class="token operator">**</span><span class="token number">2</span></code></pre>
<div class="highlight"><pre><span class="linenos">1</span>echo hi
<span class="linenos">2</span>echo bye
</pre></div>
</article>`),
    expected: {
      blocks: [
        { type: "paragraph", includes: ["a^2+b^2=c^2"], excludes: ["a²+b²"] },
        { type: "code", language: "python", includes: ["def f(x):\n    return x**2"] },
        { type: "code", includes: ["echo hi\necho bye"], excludes: ["1echo"] },
      ],
    },
  },

  "lists-tables-toggles": {
    url: "https://docs.example.com/reference/structures",
    html: shell("구조 테스트", `<article>
<h1>구조 테스트</h1>
${lorem(3)}
<ul>
  <li>1단계 A
    <ul><li>2단계 A1
      <ul><li>3단계 A1a</li><li>3단계 A1b</li></ul>
    </li></ul>
  </li>
  <li>1단계 B</li>
</ul>
<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" checked disabled> 완료된 일</li><li class="task-list-item"><input type="checkbox" disabled> 남은 일</li></ul>
<table>
  <thead><tr><th>이름</th><th>설명</th><th>값</th></tr></thead>
  <tbody>
    <tr><td colspan="2">병합된 셀</td><td>1</td></tr>
    <tr><td>b</td><td>설명 b <code>inline</code></td><td>2</td></tr>
  </tbody>
</table>
<details><summary>더 보기</summary><p>접힌 내용입니다. 토글 블록으로 저장되어야 합니다.</p><pre><code>hidden code</code></pre></details>
<dl><dt>용어</dt><dd>용어의 정의입니다.</dd></dl>
${lorem(2)}
</article>`),
    expected: {
      blocks: [
        { type: "bulleted_list_item", includes: ["1단계 A"] },
        { type: "bulleted_list_item", includes: ["2단계 A1"] },
        { type: "bulleted_list_item", includes: ["3단계 A1a"] },
        { type: "bulleted_list_item", includes: ["3단계 A1b"] },
        { type: "bulleted_list_item", includes: ["1단계 B"] },
        { type: "to_do", includes: ["완료된 일"] },
        { type: "to_do", includes: ["남은 일"] },
        { type: "table", width: 3, rows: 3, includes: ["병합된 셀 |  | 1"] },
        { type: "toggle", includes: ["더 보기"] },
        { type: "paragraph", includes: ["접힌 내용"] },
        { type: "code", includes: ["hidden code"] },
        { type: "paragraph", includes: ["용어"] },
      ],
    },
  },

  "news-trailing-junk": {
    url: "https://news.example.co.kr/article/2026/09/18/0001",
    html: shell("금리 인하 전망", `<div id="ct"><article id="dic_area" class="go_trans _article_content">
<h2 class="media_end_head_headline">금리 인하 전망</h2>
${lorem(4)}
<p>결론적으로 시장은 <a href="https://example.com/a">보고서</a>와 <a href="https://example.com/b">지표</a>를 주시하고 있다.</p>
<p>기자 이름 기자 (reporter@example.co.kr)</p>
<div class="copyright"><p>저작권자 © 예시신문 무단전재 및 재배포, AI 학습 및 활용 금지</p></div>
<div class="related"><h3>관련 기사</h3><ul><li><a href="/1">관련 기사 하나</a></li><li><a href="/2">관련 기사 둘</a></li></ul></div>
<div class="share"><a href="#">공유하기</a> <a href="#">구독하기</a></div>
</article></div>`),
    expected: {
      blocks: [
        { type: "heading_2", includes: ["금리 인하 전망"] },
        { type: "paragraph", includes: ["결론적으로 시장은"] },
      ],
      excludesText: ["관련 기사 하나", "무단전재", "구독하기"],
      includesText: ["결론적으로 시장은"],
    },
  },

  "paywall-short": {
    url: "https://premium.example.com/story/locked",
    html: shell("유료 기사", `<article>
<h1>유료 기사 제목</h1>
<p>첫 문단만 보입니다. 나머지 내용은 구독자에게만 제공됩니다.</p>
<div class="paywall-gate" id="paywall"><h3>구독 후 이어서 보시려면 로그인 하세요</h3><p>Subscribe to continue reading this article.</p><button>구독하기</button></div>
</article>`),
    expected: {
      quality: { paywall: true, lowContent: true },
    },
  },

  "images-lazy-webp-picture": {
    url: "https://wp.example.com/2026/09/photos",
    html: shell("사진 글", `<article class="entry-content">
<h1>사진 글</h1>
${lorem(3)}
<p><img class="lazyload" src="data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20width%3D%271200%27%20height%3D%27800%27%3E%3C%2Fsvg%3E" data-src="https://wp.example.com/wp-content/uploads/2026/09/photo-1.jpg" data-srcset="https://wp.example.com/wp-content/uploads/2026/09/photo-1-768.jpg 768w, https://wp.example.com/wp-content/uploads/2026/09/photo-1.jpg 1200w" alt="사진 1" width="1200" height="800"></p>
<figure><img src="https://images.unsplash.com/photo-1500000000000-abcdef?ixlib=rb-4.0&w=1200&q=80" alt="unsplash" width="1200" height="800"><figcaption>확장자 없는 CDN URL</figcaption></figure>
<picture><source type="image/webp" srcset="https://cdn.example.com/img/hero.webp"><img src="https://cdn.example.com/img/hero.webp" alt="webp" width="1000" height="600"></picture>
<p><img src="https://s3.amazonaws.com/bucket/x.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=abc" alt="signed" width="800" height="600"></p>
<p><img src="https://wp.example.com/pixel.gif" width="1" height="1" alt=""></p>
${lorem(2)}
</article>`),
    expected: {
      blocks: [
        { type: "image", includes: ["photo-1.jpg"], excludes: ["data:"] },
        { type: "image", includes: ["images.unsplash.com"] },
        { type: "image", includes: ["hero.webp"] },
        { type: "image", includes: ["X-Amz-Signature"] },
      ],
      excludesText: ["pixel.gif"],
    },
  },

  "github-blob": {
    url: "https://github.com/yemo/intact/blob/main/src/extractor.py",
    html: `<!doctype html><html><head><meta charset="utf-8"><title>intact/src/extractor.py at main · yemo/intact</title><meta name="expected-hostname" content="github.com"></head><body>
<header><nav>GitHub nav</nav></header>
<div id="repo-content"><div class="react-code-view"><textarea id="read-only-cursor-text-area" data-testid="read-only-cursor-text-area" aria-label="file content" readonly>import sys


def main(argv):
    print("hello", argv)


if __name__ == "__main__":
    main(sys.argv)
</textarea><div class="react-code-lines"><div class="react-code-line-contents">import sys</div></div></div></div>
</body></html>`,
    expected: {
      via: "site-handler",
      blocks: [
        { type: "paragraph", includes: ["yemo/intact · src/extractor.py"] },
        { type: "code", language: "python", includes: ["def main(argv):\n    print(\"hello\", argv)"], lines: 9 },
      ],
    },
  },

  "embeds-video-iframes": {
    url: "https://blog.example.com/posts/embeds",
    html: shell("임베드 테스트", `<article>
<h1>임베드 테스트</h1>
${lorem(3)}
<iframe width="560" height="315" src="https://www.youtube.com/embed/dQw4w9WgXcQ?si=abc" title="YouTube video player" frameborder="0" allowfullscreen></iframe>
<p>Gist:</p>
<iframe src="https://gist.github.com/user/abcdef.pibb" width="100%"></iframe>
<video controls src="https://cdn.example.com/media/clip.mp4" width="640"></video>
<iframe src="https://platform.twitter.com/embed/Tweet.html?id=12345"></iframe>
${lorem(2)}
</article>`),
    expected: {
      blocks: [
        { type: "video", includes: ["youtube.com/watch?v=dQw4w9WgXcQ"] },
        { type: "bookmark", includes: ["gist.github.com"] },
        { type: "bookmark", includes: ["clip.mp4"] },
        { type: "embed", includes: ["platform.twitter.com"] },
      ],
    },
  },

  "medium-like-article": {
    url: "https://medium.com/@someone/how-we-scaled-abc123",
    html: shell("How we scaled", `<article><div class="meteredContent">
<h1>How we scaled our pipeline</h1>
<p class="pw-author">By Someone · 6 min read</p>
${lorem(4)}
<h2>The code</h2>
<pre class="ql"><span class="ql-token">for i in range(3):</span><br><span class="ql-token">    print(i)</span></pre>
<figure><img alt="architecture" src="https://miro.medium.com/v2/resize:fit:1400/format:webp/1*abc.png" srcset="https://miro.medium.com/v2/resize:fit:640/format:webp/1*abc.png 640w, https://miro.medium.com/v2/resize:fit:1400/format:webp/1*abc.png 1400w" width="1400" height="700"><figcaption>Architecture</figcaption></figure>
<blockquote><p>Measure before you optimise.</p></blockquote>
<ol><li>First step</li><li>Second step</li></ol>
${lorem(2)}
</div></article>
<div class="related-posts"><h3>More from Medium</h3><a href="/x">Another story</a><a href="/y">Yet another story</a></div>`),
    expected: {
      blocks: [
        { type: "heading_1", includes: ["How we scaled"] },
        { type: "code", includes: ["for i in range(3):\n    print(i)"] },
        { type: "image", includes: ["1*abc.png"] },
        { type: "quote", includes: ["Measure before"] },
        { type: "numbered_list_item", includes: ["First step"] },
        { type: "numbered_list_item", includes: ["Second step"] },
      ],
      excludesText: ["Another story"],
      minWords: 80,
    },
  },
};

for (const [slug, f] of Object.entries(fixtures)) {
  const dir = path.join(pages, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "source.html"), f.html);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ url: f.url, ...(f.selection ? { selection: f.selection } : {}), synthetic: true }, null, 2));
  fs.writeFileSync(path.join(dir, "expected.json"), JSON.stringify(f.expected, null, 2));
}
console.log(`${Object.keys(fixtures).length} fixtures written to ${pages}`);
