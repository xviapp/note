export const paperHtml = `<!doctype html><html><head><title>arXiv fixture</title></head><body>
<header>Website navigation</header><a class="header-button" href="/abs/2503.01800v1">Abstract</a>
<a id="license-tr" href="https://creativecommons.org/licenses/by/4.0/">License: CC BY 4.0</a>
<article class="ltx_document">
<h1 class="ltx_title ltx_title_document">A paper &amp; its equations</h1>
<div class="ltx_authors"><span class="ltx_personname">Test Author</span></div>
<div class="ltx_abstract"><h6>Abstract</h6><p>Reading a mathematical paper.</p></div>
<nav>Duplicate website contents</nav>
<script>window.paperInjected = true</script><style>body { display:none }</style>
<section id="S1"><h2 class="ltx_title">1 Introduction</h2>
<p>The energy is <math xmlns="http://www.w3.org/1998/Math/MathML" alttext="E=mc^2"><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></math>.</p>
<p><a href="#S2.E1">Equation 1</a> and <a href="#bib.b1">Reference 1</a>.</p>
<figure id="S1.F1"><img src="2503.01800v1/figure.png" alt="Paper diagram" width="320" height="180"><figcaption>Figure 1. An explanatory diagram.</figcaption></figure>
${'<p>Paragraph to exercise the continuous reading area and position memory.</p>'.repeat(20)}
</section>
<section id="S2"><h2 class="ltx_title">2 Main result</h2>
<table id="S2.E1" class="ltx_equation"><tbody><tr><td class="ltx_eqn_eqno">(1)</td><td><math xmlns="http://www.w3.org/1998/Math/MathML" display="block" alttext="\\int_0^1 x^2 dx=\\frac{1}{3}"><mrow><mo>∫</mo><msup><mi>x</mi><mn>2</mn></msup><mi>d</mi><mi>x</mi><mo>=</mo><mfrac><mn>1</mn><mn>3</mn></mfrac></mrow></math></td></tr></tbody></table>
${'<p>The proof continues with a sequence of estimates.</p>'.repeat(20)}
</section>
<section id="bib"><h2 class="ltx_title">References</h2><ol><li id="bib.b1">Test reference.</li></ol></section>
</article><footer>Website footer</footer></body></html>`;
export const paperPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1cAAAAASUVORK5CYII=';
