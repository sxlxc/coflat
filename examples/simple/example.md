---
title: Lorem Ipsum — A Mathematical Notebook
author: A. Example
description: A synthetic research-style document with placeholder prose and elementary mathematics.
math:
  R: '\mathbb{R}'
  N: '\mathbb{N}'
  norm: '\left\lVert #1\right\rVert'
---

::: {.abstract}
Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. This fictional notebook contains placeholder prose and assorted elementary formulas for exploring mathematical writing in Coflat. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat, with $x\in\R$, $n\in\N$, and $\varepsilon>0$ throughout.
:::

# Lorem ipsum

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer vitae justo eget magna fermentum iaculis. For $a,b\in\R$, the symbols $a+b$, $ab$, and $a^2+b^2$ provide a first collection of inline expressions. Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas.

::: {.definition #def:sequence title="Lorem sequence"}
Lorem ipsum dolor sit amet. For $n\ge 0$, let $u_n=\sum_{j=0}^{n}2^{-j}$ and $v_n=2-u_n$. Suspendisse potenti, praesent elementum facilisis leo vel fringilla.
:::

::: {.equation #eq:geometric}
$$
u_n=\frac{1-2^{-(n+1)}}{1-\frac12}=2-2^{-n}.
$$
:::

::: {.theorem #thm:sequence title="Dolor sit amet"}
Lorem ipsum dolor sit amet, consectetur adipiscing elit. The sequence in [@def:sequence] satisfies $1\le u_n<2$ and $\lim_{n\to\infty}u_n=2$.
:::

::: {.proof}
Sed ut perspiciatis unde omnis iste natus error sit voluptatem. Multiplying the finite sum by $1/2$ and subtracting gives [@eq:geometric]. Since $0<2^{-n}\le1$, the bounds follow. For every $\varepsilon>0$, choose an integer $N>\log_2(1/\varepsilon)$; then $n\ge N$ implies $|u_n-2|=2^{-n}<\varepsilon$. Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit.
:::

Donec pretium vulputate sapien nec sagittis aliquam malesuada bibendum. In [@thm:sequence], the remainder is $v_n=2^{-n}$; more generally, for $|r|<1$,

$$
\sum_{j=0}^{n}r^j=\frac{1-r^{n+1}}{1-r},
\qquad
\sum_{j=0}^{\infty}r^j=\frac{1}{1-r}.
$$

# Consectetur adipiscing

Mauris ultrices eros in cursus turpis massa tincidunt dui. Consider the polynomial $p(t)=t^3-3t+1$, its derivative $p'(t)=3t^2-3$, and the sample values $p(-1)=3$, $p(0)=1$, $p(1)=-1$. Amet consectetur adipiscing elit pellentesque habitant morbi tristique senectus.

::: {.lemma #lem:squares title="Elit pellentesque"}
Lorem ipsum dolor sit amet. For all $x,y\in\R$,

$$
2xy\le x^2+y^2,
$$

with equality precisely when $x=y$.
:::

::: {.proof}
Ut enim ad minima veniam, quis nostrum exercitationem ullam corporis suscipit laboriosam. Expand $(x-y)^2=x^2-2xy+y^2\ge0$. Equality holds precisely when the square vanishes. Quis autem vel eum iure reprehenderit qui in ea voluptate velit esse quam nihil molestiae consequatur.
:::

:::: {.proposition #prop:average title="Amet $m$ and $d$"}
For $m=(x+y)/2$ and $d=(x-y)/2$, one has $x^2+y^2=2m^2+2d^2$. Lorem ipsum dolor sit amet, consectetur adipiscing elit.

::: {.proof}
Substitute $x=m+d$ and $y=m-d$. The mixed terms cancel:

$$
(m+d)^2+(m-d)^2=2m^2+2d^2.
$$

Nunc sed velit dignissim sodales ut eu sem integer vitae.
:::
::::

::: {.corollary #cor:average title="Vitae justo"}
For $x,y\in\R$, $((x+y)/2)^2\le(x^2+y^2)/2$, by [@prop:average]. Egestas integer eget aliquet nibh praesent tristique magna sit amet.
:::

# Sed do eiusmod

Aliquam vestibulum morbi blandit cursus risus at ultrices mi tempus. Let $f(x)=x^4/4-x^2/2$ and $g(x)=e^{-x^2}$. The derivatives $f'(x)=x^3-x$ and $g'(x)=-2xe^{-x^2}$ sit beside a collection of definite integrals. Quam viverra orci sagittis eu volutpat odio facilisis mauris sit.

::: {.equation #eq:integrals}
$$
\begin{aligned}
\int_0^1 x^m\,dx &= \frac{1}{m+1} && (m\ge0),\\
\int_0^{\pi}\sin x\,dx &= 2,\\
\int_1^e \frac{1}{x}\,dx &= 1.
\end{aligned}
$$
:::

::: {.theorem #thm:integral title="Tempor incididunt"}
Lorem ipsum dolor sit amet. If $f:[0,1]\to\R$ is continuous and $a\le f(x)\le b$ for every $x\in[0,1]$, then $a\le\int_0^1f(x)\,dx\le b$.
:::

::: {.proof}
At vero eos et accusamus et iusto odio dignissimos ducimus. Integrate the nonnegative functions $f-a$ and $b-f$ over $[0,1]$. This gives $\int_0^1f(x)\,dx-a\ge0$ and $b-\int_0^1f(x)\,dx\ge0$. Et harum quidem rerum facilis est et expedita distinctio.
:::

Quisque egestas diam in arcu cursus euismod quis viverra nibh. For $h>0$, a difference quotient supplies another display:

$$
\frac{(x+h)^3-x^3}{h}=3x^2+3xh+h^2
\xrightarrow[h\to0]{}3x^2.
$$

::: {.remark #rem:calculus title="Labore et dolore"}
Lorem ipsum dolor sit amet, consectetur adipiscing elit. The identities in [@eq:integrals] and the bounds in [@thm:integral] are elementary examples. Nibh ipsum consequat nisl vel pretium lectus quam id leo.
:::

# Magna aliqua

Viverra ipsum nunc aliquet bibendum enim facilisis gravida neque convallis. Let $A\in\R^{2\times2}$ and $z\in\R^2$. Matrices, column vectors, and norms provide another set of unrelated mathematical textures. Lectus urna duis convallis convallis tellus id interdum velit laoreet.

::: {.equation #eq:matrix}
$$
A=\begin{pmatrix}2&1\\1&2\end{pmatrix},
\qquad
z=\begin{pmatrix}x\\y\end{pmatrix},
\qquad
Az=\begin{pmatrix}2x+y\\x+2y\end{pmatrix}.
$$
:::

::: {.lemma #lem:matrix title="Enim facilisis"}
For the matrix in [@eq:matrix], $z^{\mathsf T}Az\ge\norm{z}_2^2$ for every $z\in\R^2$. Lorem ipsum dolor sit amet, consectetur adipiscing elit.
:::

::: {.proof}
Consequat interdum varius sit amet mattis vulputate enim nulla aliquet. Direct expansion gives

$$
z^{\mathsf T}Az=2x^2+2xy+2y^2
=x^2+y^2+(x+y)^2\ge x^2+y^2.
$$

The last expression is $\norm{z}_2^2$. Facilisi nullam vehicula ipsum a arcu cursus vitae congue mauris.
:::

::: {.proposition #prop:determinant title="Gravida neque"}
Lorem ipsum dolor sit amet. The characteristic polynomial of $A$ is $\det(A-\lambda I)=(\lambda-1)(\lambda-3)$.
:::

::: {.proof}
Compute $(2-\lambda)^2-1=\lambda^2-4\lambda+3$. Factoring gives the asserted expression, so the eigenvalues are $1$ and $3$. Tristique senectus et netus et malesuada fames ac turpis egestas.
:::

$$
Q=\frac{1}{\sqrt2}\begin{pmatrix}1&1\\-1&1\end{pmatrix},
\qquad
Q^{\mathsf T}AQ=\begin{pmatrix}1&0\\0&3\end{pmatrix}.
$$

# Ut enim ad minim

Pellentesque nec nam aliquam sem et tortor consequat id porta. For a finite probability space, write $\mathbb P(E)$ for an event and $\mathbb E[X]$ for the mean of a random variable. Velit aliquet sagittis id consectetur purus ut faucibus pulvinar elementum.

::: {.definition #def:coin title="Veniam quis nostrud"}
Let $X_1,\ldots,X_n$ be independent variables with $\mathbb P(X_i=1)=p$ and $\mathbb P(X_i=0)=1-p$, where $0\le p\le1$. Put $S_n=\sum_{i=1}^nX_i$. Lorem ipsum dolor sit amet, consectetur adipiscing elit.
:::

::: {.theorem #thm:coin title="Exercitation ullamco"}
The variables in [@def:coin] satisfy $\mathbb E[S_n]=np$ and $\operatorname{Var}(S_n)=np(1-p)$.
:::

::: {.proof}
Lorem ipsum dolor sit amet, consectetur adipiscing elit. Since $X_i^2=X_i$, one has $\mathbb E[X_i]=p$ and $\operatorname{Var}(X_i)=p-p^2$. Linearity gives the mean, and independence makes every covariance with distinct indices vanish:

$$
\operatorname{Var}(S_n)
=\sum_{i=1}^{n}\operatorname{Var}(X_i)
+2\sum_{i<j}\operatorname{Cov}(X_i,X_j)
=np(1-p).
$$

Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.
:::

::: {.equation #eq:binomial}
$$
\mathbb P(S_n=k)=\binom{n}{k}p^k(1-p)^{n-k},
\qquad 0\le k\le n.
$$
:::

::: {.table #tbl:samples title="Synthetic sample values"}
| $n$ | $p$ | $\mathbb E[S_n]$ | $\operatorname{Var}(S_n)$ |
| ---: | ---: | ---: | ---: |
| $4$ | $1/2$ | $2$ | $1$ |
| $8$ | $1/4$ | $2$ | $3/2$ |
| $12$ | $1/3$ | $4$ | $8/3$ |
:::

Nisl tincidunt eget nullam non nisi est sit amet facilisis. The illustrative values in [@tbl:samples] follow from [@thm:coin]. Duis convallis convallis tellus id interdum velit laoreet id donec ultrices.

# Duis aute irure

Eget dolor morbi non arcu risus quis varius quam quisque. Set $z=x+iy$ with $i^2=-1$, and consider $|z|=\sqrt{x^2+y^2}$ and $\overline z=x-iy$. Sollicitudin ac orci phasellus egestas tellus rutrum tellus pellentesque eu.

::: {.equation #eq:rotation}
$$
e^{i\theta}=\cos\theta+i\sin\theta,
\qquad
\begin{pmatrix}x'\\y'\end{pmatrix}
=\begin{pmatrix}\cos\theta&-\sin\theta\\\sin\theta&\cos\theta\end{pmatrix}
\begin{pmatrix}x\\y\end{pmatrix}.
$$
:::

:::: {.theorem #thm:rotation title="Dolor in reprehenderit"}
The transformation in [@eq:rotation] preserves squared length: $(x')^2+(y')^2=x^2+y^2$. Lorem ipsum dolor sit amet, consectetur adipiscing elit.

::: {.proof}
Write $c=\cos\theta$ and $s=\sin\theta$. Expanding the two squares yields

$$
(cx-sy)^2+(sx+cy)^2=(c^2+s^2)(x^2+y^2)=x^2+y^2.
$$

The mixed terms cancel and $c^2+s^2=1$. Turpis egestas integer eget aliquet nibh praesent tristique magna.
:::
::::

::: {.example #ex:rotation title="Voluptate velit"}
For $\theta=\pi/2$, the point $(3,4)$ becomes $(-4,3)$, and both have length $5$. For $\theta=\pi$, it becomes $(-3,-4)$. Lorem ipsum dolor sit amet, consectetur adipiscing elit.
:::

# Cillum dolore

Ornare quam viverra orci sagittis eu volutpat odio facilisis mauris. Let $\Omega=\{1,\ldots,n\}$ and let $A,B\subseteq\Omega$. Set notation and binomial coefficients offer a different family of examples. Aliquet risus feugiat in ante metus dictum at tempor commodo.

::: {.lemma #lem:sets title="Eu fugiat nulla"}
Lorem ipsum dolor sit amet. For finite sets $A$ and $B$,

$$
|A\cup B|=|A|+|B|-|A\cap B|.
$$
:::

::: {.proof}
The sets $A\setminus B$, $B\setminus A$, and $A\cap B$ are pairwise disjoint and their union is $A\cup B$. Counting these three pieces proves the identity. Amet nisl suscipit adipiscing bibendum est ultricies integer quis auctor elit.
:::

::: {.proposition #prop:binomial title="Pariatur excepteur"}
For each integer $n\ge0$, $\sum_{k=0}^{n}\binom{n}{k}=2^n$. Lorem ipsum dolor sit amet, consectetur adipiscing elit.
:::

::: {.proof}
Each element of $\Omega$ may either belong to a subset or be absent, giving $2^n$ subsets. Sorting them by their cardinality $k$ gives the sum. Equivalently, evaluate the binomial expansion at $a=b=1$:

$$
(a+b)^n=\sum_{k=0}^{n}\binom{n}{k}a^kb^{n-k}.
$$

Sed blandit libero volutpat sed cras ornare arcu dui vivamus.
:::

Morbi tincidunt augue interdum velit euismod in pellentesque massa placerat. Beside [@lem:sets] and [@prop:binomial], a small alternating sum reads

$$
\sum_{k=0}^{n}(-1)^k\binom{n}{k}=0\quad(n\ge1),
\qquad
\binom{n}{k}=\binom{n}{n-k}.
$$

# Sint occaecat

Faucibus interdum posuere lorem ipsum dolor sit amet consectetur. Consider a scalar function $F(x,y)=x^2+3y^2$ and its gradient $\nabla F=(2x,6y)$. Amet venenatis urna cursus eget nunc scelerisque viverra mauris in aliquam.

::: {.equation #eq:gradient}
$$
\nabla^2F=\begin{pmatrix}2&0\\0&6\end{pmatrix},
\qquad
D_vF(x,y)=2xv_1+6yv_2.
$$
:::

::: {.theorem #thm:minimum title="Cupidatat non proident"}
The function $F(x,y)=x^2+3y^2$ has a unique global minimum at $(0,0)$, with value $0$. Lorem ipsum dolor sit amet, consectetur adipiscing elit.
:::

::: {.proof}
Both terms are nonnegative, so $F(x,y)\ge0$. Equality forces $x^2=0$ and $3y^2=0$, hence $x=y=0$. Conversely, $F(0,0)=0$. Lacus vel facilisis volutpat est velit egestas dui id ornare.
:::

::: {.remark #rem:level title="Sunt in culpa"}
For $c>0$, the level set $F(x,y)=c$ is the ellipse $x^2/c+y^2/(c/3)=1$. Lorem ipsum dolor sit amet, consectetur adipiscing elit. The gradient in [@eq:gradient] is perpendicular to its tangent wherever defined.
:::

$$
x(t)=\sqrt c\cos t,
\qquad y(t)=\sqrt{c/3}\sin t,
\qquad 0\le t<2\pi.
$$

# Qui officia deserunt

Lorem ipsum dolor sit amet, consectetur adipiscing elit. An unrelated recurrence $a_0=0$, $a_{n+1}=a_n+2n+1$ closes this collection of sample arguments. Urna neque viverra justo nec ultrices dui sapien eget mi proin.

::: {.theorem #thm:odd-sum title="Mollit anim"}
For every $n\ge0$, $a_n=n^2$. Equivalently, the first $n$ positive odd integers sum to $n^2$.
:::

::: {.proof}
The initial case is $a_0=0=0^2$. If $a_n=n^2$, then $a_{n+1}=n^2+2n+1=(n+1)^2$. Induction proves the claim. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
:::

::: {.equation #eq:telescoping}
$$
\sum_{j=0}^{n-1}(2j+1)
=\sum_{j=0}^{n-1}\bigl((j+1)^2-j^2\bigr)
=n^2.
$$
:::

::: {.corollary #cor:successive title="Id est laborum"}
For every $n\ge0$, $a_{n+1}-a_n=2n+1$, and $a_{n+2}-2a_{n+1}+a_n=2$.
:::

::: {.proof}
Substitute [@thm:odd-sum] into each expression and expand the squares. The first differences are consecutive odd integers, so their differences are $2$. Nunc consequat interdum varius sit amet mattis vulputate enim nulla.
:::

# Finis lorem

Lorem ipsum dolor sit amet, consectetur adipiscing elit. The geometric series [@eq:geometric], integral examples [@eq:integrals], matrix [@eq:matrix], and telescoping sum [@eq:telescoping] are independent pieces of sample mathematics. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.

Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas. With $\alpha=1/3$, $\beta=\sqrt2$, and $\gamma=\pi$, one final display brings together sums, products, and a limit:

$$
\sum_{j=1}^{m}j=\frac{m(m+1)}2,
\qquad
\prod_{j=1}^{m}\frac{j+1}{j}=m+1,
\qquad
\lim_{m\to\infty}\left(1+\frac1m\right)^m=e.
$$

Donec ac odio tempor orci dapibus ultrices in iaculis nunc. Egestas tellus rutrum tellus pellentesque eu tincidunt tortor aliquam nulla. Lorem ipsum dolor sit amet, consectetur adipiscing elit.
