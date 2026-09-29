import { latexModel } from '@froglight/foundation';

// Keep the source portable and within the bundled LaTeX.js preview vocabulary.
export const designNotes = latexModel(String.raw`\documentclass{article}
\usepackage{hyperref}
\usepackage{xcolor}
\usepackage{multicol}
\title{Asteria: From Orbit to Engineering Judgment}
\author{Aerospace Design Studio}
\date{September 2026}
\begin{document}
\maketitle
\begin{abstract}
A small spacecraft is a useful place to learn large systems thinking.
This fictional six-unit CubeSat study connects a circular reference orbit,
eclipse survival, pointing and data return. The numbers are transparent
classroom assumptions, not flight requirements. The purpose is to keep
sketches, equations and engineering decisions in one inspectable argument.
\end{abstract}
\tableofcontents

\section{Mission question}
Can a student team return one calibrated coastal image and explain its
uncertainty? The payload objective is deliberately modest. The systems
problem is not: useful data must survive every interface between scene,
optics, attitude, storage, radio and the ground.
\begin{quote}
A good first model makes its assumptions easier to challenge.
\end{quote}
\noindent\textbf{Scope.} Asteria is an original educational concept, unrelated
to any real mission of the same name. All numerical design choices here
are illustrative. The companion Reading room note records primary
background references and the assumptions omitted by each model.

\subsection{Working requirements}
\begin{enumerate}
\item Use a common reference orbit across all first-pass budgets.
\item Separate eclipse survival from science operation.
\item Record the evidence needed before freezing an architecture.
\end{enumerate}
\begin{description}
\item[Payload] A notional optical camera with a $2048\times2048$ detector.
\item[Bus] A six-unit form factor with power, control and communication services.
\item[Operations] Store images on board and transmit during selected passes.
\end{description}

\section{The orbit becomes a clock}
Let $\mu=398600 \mathrm{km^3 s^{-2}}$, $R=6378 \mathrm{km}$ and
$h=500 \mathrm{km}$. Radius means distance from the centre of Earth:
\[
r=R+h=6878 \mathrm{km}.
\]
Balancing gravitational and centripetal acceleration gives
\[
\frac{\mu}{r^2}=\frac{v^2}{r},\qquad
v=\sqrt{\frac{\mu}{r}}\approx7.61 \mathrm{km s^{-1}}.
\]
The associated period is
\[
T=\frac{2\pi r}{v}=2\pi\sqrt{\frac{r^3}{\mu}}
\approx5676 \mathrm{s}\approx94.6 \mathrm{min}.
\]
\subsubsection{A useful dimensional check}
\[
\sqrt{\frac{\mathrm{km^3 s^{-2}}}{\mathrm{km}}}
=\mathrm{km s^{-1}}.
\]
\paragraph{Boundary of the model.}
The calculation neglects atmospheric drag, oblateness and injection error.
It establishes a scale; it does not predict a lifetime or a ground pass.
\begin{center}
\textcolor{teal}{Geometry $\longrightarrow$ time $\longrightarrow$ energy.}
\end{center}

\section{Energy through the dark arc}
Take an illustrative eclipse interval of $0.60 \mathrm{h}$ and a constant
survival load of $12 \mathrm{W}$. The load energy, conversion efficiency
and usable capacity fraction must remain distinct:
\[
\begin{aligned}
E_{\mathrm{load}} &= P_{\mathrm{bus}}t_{\mathrm{eclipse}} = 7.2 \mathrm{Wh},\\
E_{\mathrm{pack}} &\geq \frac{E_{\mathrm{load}}}{\eta f}
=\frac{7.2}{0.80\times0.30}=30 \mathrm{Wh}.
\end{aligned}
\]
\begin{itemize}
\item The capacity result is a simplified lower bound.
\item Cold performance and aging need explicit treatment.
\item Peak current requires a separate electrical check.
\item Recovery in sunlight is necessary for repeated-orbit operation.
\end{itemize}
A simple operations policy can be written as a piecewise load:
\[
P(t)=\begin{cases}
P_{\mathrm{safe}}, & \text{during recovery},\\
P_{\mathrm{bus}}+P_{\mathrm{payload}}, & \text{during imaging},\\
P_{\mathrm{bus}}+P_{\mathrm{radio}}, & \text{during downlink}.
\end{cases}
\]
\begin{quotation}
Reserve is most useful when it remains visible in the timeline.
A single percentage cannot explain when a load is allowed to run, or
which event should return the spacecraft to a lower-power mode.
\end{quotation}

\section{Pointing meets image quality}
For one rigid-body axis, $I\ddot\theta=\tau$. With a reference
$\theta_r$, define $e=\theta_r-\theta$ and consider
\[
\tau=K_p e+K_d\dot e.
\]
The state-space notation makes the double integrator visible:
\[
\dot{\mathbf{x}}=
\begin{bmatrix}0&1\\0&0\end{bmatrix}\mathbf{x}+
\begin{bmatrix}0\\1/I\end{bmatrix}\tau,
\qquad
\mathbf{x}=\begin{bmatrix}\theta\\\dot\theta\end{bmatrix}.
\]
For small motion at approximately constant angular rate, angular smear
is $\Delta\theta\approx\omega t_{\mathrm{exp}}$. Compare this with the
angular pixel scale before increasing exposure or controller gain.
\begin{flushleft}
\textbf{Bench question:} What improves first: settling time, image sharpness,
or the appearance of the step-response plot?
\end{flushleft}
\begin{flushright}
Measure the mission quantity.
\end{flushright}

\section{The data must come home}
Raw image size is straightforward if the units stay visible:
\[
N=2048^2\times12=50331648 \mathrm{bits}
\approx6.29 \mathrm{MB}.
\]
At a fictional useful payload rate of $10^6 \mathrm{bit s^{-1}}$,
transmission takes about $50.3 \mathrm{s}$, before additional overhead.
A nominal $300 \mathrm{s}$ pass carries at most $37.5 \mathrm{MB}$
at that rate. Actual useful delivery depends on acquisition, coding,
protocols, scheduling and losses.

\[
\begin{array}{lrl}
\hline
\text{Quantity} & \text{Assumption} & \text{Unit} \\
\hline
\text{Orbit altitude} & 500 & \mathrm{km} \\
\text{Circular period} & 94.6 & \mathrm{min} \\
\text{Eclipse interval} & 36 & \mathrm{min} \\
\text{Survival bus load} & 12 & \mathrm{W} \\
\text{Capacity lower bound} & 30 & \mathrm{Wh} \\
\text{Raw image size} & 6.29 & \mathrm{MB} \\
\hline
\end{array}
\]
\begin{center}
\textit{Table 1. One consistent teaching case. Rounded values are not requirements.}
\end{center}

\section{Trade study before component selection}
\begin{multicols}{2}
\textbf{Body-mounted arrays}
\begin{itemize}
\item Fewer deployment mechanisms.
\item Collection tied to body pointing.
\item Limited available face area.
\end{itemize}
\textbf{Deployable arrays}
\begin{itemize}
\item More collection-area freedom.
\item Additional deployment uncertainty.
\item Changed inertia and projected area.
\end{itemize}
\end{multicols}
A weighted score $S_j=\sum_i w_i s_{ij}$ is a record of preferences.
Sensitivity to the weights is part of the result, not an inconvenience.
\begin{verse}
Sketch the interface.\\
Name the assumption.\\
Bring back evidence.
\end{verse}

\section{Verification notebook}
\begin{quote}
\texttt{case: eclipse-survival}\\
\texttt{inputs: bus load = 12 W; shadow = 36 min}\\
\texttt{observe: energy, minimum voltage, recovery time}\\
\texttt{pass: load supported; reserve respected}\\
\texttt{next: repeat with cold-capacity and aging assumptions}
\end{quote}
\subsection{Uncertainty and sensitivity}
For independent small input errors, a local first-order approximation is
\[
\sigma_y^2\approx\sum_i\left(\frac{\partial y}{\partial x_i}\right)^2
\sigma_{x_i}^2.
\]
Dependence requires covariance terms. A deterministic margin does not
replace an uncertainty model. For circular speed,
\[
\frac{\delta v}{v}\approx-\frac{1}{2}\frac{\delta r}{r}.
\]
\subsection{Review exit criteria}
\begin{enumerate}
\item One common assumption register across orbit, power and data notes.
\item One recorded test that can falsify the current array preference.
\item One decision record with a clear reconsideration trigger.
\end{enumerate}

\section{Reading and continuation}
NASA's \href{https://www.nasa.gov/smallsat-institute/sst-soa/}{Small Spacecraft
Technology report} is a starting point for deeper subsystem research.
The companion Froglight notes connect the same questions to editable
ink plates, a three-page notebook and the design-room whiteboard.
\begin{center}
\textit{The next useful result may be a better question.}
\end{center}
\end{document}
`);
