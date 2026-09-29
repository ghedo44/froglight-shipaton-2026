/** Source installed as .froglight/plugins/froglight.demo-calculator/main.js.
 * It uses the public trusted plugin facade; the shell supplies the window.
 */
export const calculatorPluginSource = String.raw`
export function activate({ uiViews }) {
  uiViews.register({
    id: 'froglight.demo-calculator',
    area: 'activity',
    title: 'Calculator',
    icon: 'math',
    mount(container) {
      const style = document.createElement('style');
      style.textContent = '.demo-calc{padding:14px;display:grid;gap:10px;font:inherit}.demo-calc-display{padding:10px 12px;text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;background:var(--fl-surface-sunken);border-radius:var(--fl-radius-md)}.demo-calc-expression{min-height:20px;font-size:13px;line-height:20px;color:var(--fl-text-muted)}.demo-calc output{display:block;min-height:40px;font-size:28px;line-height:40px}.demo-calc-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}.demo-calc button{min-height:44px;border-radius:var(--fl-radius-md);background:var(--fl-surface-hover);color:var(--fl-text-primary);font:inherit;font-size:16px}.demo-calc button:hover{background:var(--fl-surface-active)}.demo-calc button:focus-visible{outline:2px solid var(--fl-accent);outline-offset:2px}.demo-calc button[data-key="="]{background:var(--fl-accent);color:var(--fl-accent-contrast)}';
      const root = document.createElement('div');
      root.className = 'demo-calc';
      root.tabIndex = 0;
      const screen = document.createElement('div');
      screen.className = 'demo-calc-display';
      const expression = document.createElement('div');
      expression.className = 'demo-calc-expression';
      const display = document.createElement('output');
      display.setAttribute('aria-live', 'polite');
      display.textContent = '0';
      const grid = document.createElement('div');
      grid.className = 'demo-calc-grid';
      const keys = ['C', '⌫', '%', '÷', '7', '8', '9', '×', '4', '5', '6', '−', '1', '2', '3', '+', '±', '0', '.', '='];
      let current = '0';
      let previous = null;
      let operator = null;
      let fresh = false;
      let parts = [];
      let completedExpression = '';
      const show = () => {
        expression.textContent = completedExpression;
        display.textContent = operator
          ? parts.join(' ') + (fresh ? '' : ' ' + current)
          : current;
      };
      const calculate = (a, b, op) => {
        if (op === '+') return a + b;
        if (op === '−') return a - b;
        if (op === '×') return a * b;
        if (op === '÷') return b === 0 ? NaN : a / b;
        return b;
      };
      const format = (value) => Number.isFinite(value) ? String(Number(value.toPrecision(12))) : 'Error';
      function press(key) {
        if (/^[0-9]$/.test(key)) {
          completedExpression = '';
          current = fresh || current === 'Error' ? key : current === '0' ? key : current === '-0' ? '-' + key : current.length < 16 ? current + key : current;
          fresh = false;
        } else if (key === '.') {
          completedExpression = '';
          if (fresh || current === 'Error') { current = '0.'; fresh = false; }
          else if (!current.includes('.')) current += '.';
        } else if (key === 'C') {
          current = '0'; previous = null; operator = null; fresh = false; parts = []; completedExpression = '';
        } else if (key === '⌫') {
          completedExpression = '';
          if (operator && fresh) {
            current = format(previous); previous = null; operator = null; parts = [];
          } else {
            current = current === 'Error' || current.length <= 1 ? '0' : current.slice(0, -1);
            if (current === '-') current = '0';
          }
          fresh = false;
        } else if (key === '±') {
          completedExpression = '';
          if (operator && fresh) { current = '-0'; fresh = false; }
          else if (current !== '0' && current !== 'Error') current = current.startsWith('-') ? current.slice(1) : '-' + current;
        } else if (key === '%') {
          completedExpression = '';
          if (operator && fresh) { current = '0'; fresh = false; }
          current = format(Number(current) / 100);
        } else if (key === '=') {
          if (operator && previous !== null) {
            completedExpression = parts.concat(current).join(' ') + ' =';
            current = format(calculate(previous, Number(current), operator));
          }
          previous = null; operator = null; parts = []; fresh = true;
        } else {
          if (current === 'Error') return;
          completedExpression = '';
          if (operator && fresh) {
            // Choosing another operator replaces the pending one.
            parts[parts.length - 1] = key;
          } else if (operator && previous !== null) {
            const entered = parts.concat(current);
            // Keep the expression faithful to this calculator's immediate
            // evaluation when a later multiply/divide uses an earlier sum.
            parts = (key === '×' || key === '÷') && (operator === '+' || operator === '−')
              ? ['(' + entered.join(' ') + ')', key]
              : entered.concat(key);
            current = format(calculate(previous, Number(current), operator));
          } else {
            parts = [current, key];
          }
          if (current === 'Error') { previous = null; operator = null; parts = []; }
          else { previous = Number(current); operator = key; fresh = true; }
        }
        show();
      }
      for (const key of keys) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = key;
        button.dataset.key = key;
        button.addEventListener('click', () => press(key));
        grid.append(button);
      }
      root.addEventListener('keydown', (event) => {
        const key = ({ '*': '×', '/': '÷', '-': '−', 'Enter': '=', 'Backspace': '⌫', 'Escape': 'C' })[event.key] || event.key;
        if (keys.includes(key)) { event.preventDefault(); press(key); }
      });
      screen.append(expression, display);
      root.append(screen, grid);
      container.append(style, root);
      return () => { style.remove(); root.remove(); };
    },
  });
}
`;

export const calculatorPluginManifest = {
  manifestVersion: 1,
  id: 'froglight.demo-calculator',
  version: '0.1.0',
  froglightSdk: '*',
  permissions: ['ui.views.register'],
} as const;
