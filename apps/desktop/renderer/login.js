/** 企业登录窗（fork 补丁）：凭据只经 IPC 交给主进程处理，页面自身不发起网络请求。 */

const api = window.dshDesktop?.enterprise
const locale = window.dshDesktop?.locale

const $ = (id) => document.getElementById(id)

function text(id, value) {
  const node = $(id)
  if (node) node.textContent = value
}

let messages = {}
let submitLabel = 'Sign in'
let submittingLabel = 'Signing in…'
let successLabel = 'Signed in.'

const CONFETTI_COLORS = ['#3370ff', '#744bff', '#22c55e', '#facc15', '#f472b6', '#00c4cc']
const CONFETTI_DURATION_MS = 1500

/** 登录成功彩带：仅在服务端 enroll 真实成功后播放，服务端拒绝时不出现。 */
function celebrate() {
  const canvas = $('confetti')
  const context = canvas?.getContext?.('2d')
  if (!canvas || !context) return
  const ratio = window.devicePixelRatio || 1
  const width = canvas.clientWidth || window.innerWidth
  const height = canvas.clientHeight || window.innerHeight
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  const originX = width / 2
  const originY = height * 0.4
  const particles = Array.from({ length: 90 }, () => {
    const angle = Math.random() * Math.PI * 2
    const speed = 2.4 + Math.random() * 5
    return {
      x: originX,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 3.4,
      size: 4 + Math.random() * 4,
      rotation: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.3,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
    }
  })
  const started = performance.now()
  const frame = (now) => {
    const elapsed = now - started
    context.clearRect(0, 0, width, height)
    for (const particle of particles) {
      particle.vy += 0.16
      particle.vx *= 0.99
      particle.x += particle.vx
      particle.y += particle.vy
      particle.rotation += particle.spin
      context.save()
      context.globalAlpha = Math.max(0, 1 - elapsed / CONFETTI_DURATION_MS)
      context.translate(particle.x, particle.y)
      context.rotate(particle.rotation)
      context.fillStyle = particle.color
      context.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size * 0.62)
      context.restore()
    }
    if (elapsed < CONFETTI_DURATION_MS) requestAnimationFrame(frame)
    else context.clearRect(0, 0, width, height)
  }
  requestAnimationFrame(frame)
}

function showError(message) {
  const node = $('error')
  node.textContent = message
  node.hidden = false
}

function initPasswordReveal() {
  const button = $('reveal')
  const input = $('password')
  button.addEventListener('click', () => {
    const revealed = button.getAttribute('aria-pressed') === 'true'
    button.setAttribute('aria-pressed', revealed ? 'false' : 'true')
    button.setAttribute('aria-label', revealed
      ? messages.loginShowPassword ?? 'Show password'
      : messages.loginHidePassword ?? 'Hide password')
    input.type = revealed ? 'password' : 'text'
  })
}

async function init() {
  try { messages = (await locale?.())?.messages ?? {} } catch { /* locale unavailable */ }

  document.documentElement.lang = navigator.language?.startsWith('zh') ? 'zh-CN' : 'en'
  text('page-title', messages.enterpriseLoginWindowTitle ?? 'Sign in')
  text('brand-mark', messages.loginBrandMark ?? '维')
  text('brand-name', messages.loginBrandName ?? '')
  text('internal-badge', messages.loginInternalBadge ?? 'Internal')
  text('heading', messages.loginHeading ?? 'Sign in')
  text('description', messages.loginDescription ?? '')
  text('env-label', messages.loginEnvironment ?? 'Environment')
  text('email-label', messages.loginEmail ?? 'Email')
  text('password-label', messages.loginPassword ?? 'Password')
  text('footer', messages.loginFooter ?? '')

  submitLabel = messages.loginSubmit ?? 'Sign in'
  submittingLabel = messages.loginSubmitting ?? 'Signing in…'
  successLabel = messages.loginSuccess ?? successLabel
  text('submit-label', submitLabel)
  $('reveal').setAttribute('aria-label', messages.loginShowPassword ?? 'Show password')
  initPasswordReveal()

  let context
  try {
    context = await api.context()
  } catch (error) {
    showError(String(error))
    return
  }

  if (context.appName) text('brand-name', context.appName)
  $('internal-badge').hidden = !context.internal

  const envSelect = $('env')
  for (const option of context.environments) {
    const node = document.createElement('option')
    node.value = option.url
    node.textContent = option.label
    envSelect.appendChild(node)
  }
  if (context.defaultUrl) envSelect.value = context.defaultUrl
  if (context.savedEmail) $('email').value = context.savedEmail

  // 环境切换只对内部模式开放（DSH_ENTERPRISE_INTERNAL=1）；普通用户锁定构建期通道，
  // 页面不渲染任何切换入口，也不保留连点后门。
  $('env-field').hidden = !context.internal
}

$('form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const button = $('submit')
  const label = $('submit-label')
  if (button.disabled) return
  button.disabled = true
  $('spinner').hidden = false
  $('error').hidden = true
  label.textContent = submittingLabel
  try {
    const result = await api.submit({
      serverUrl: $('env').value,
      email: $('email').value.trim(),
      password: $('password').value,
    })
    if (result?.ok) {
      $('card').classList.add('is-success')
      text('heading', messages.loginWelcome ?? 'Welcome')
      text('description', messages.loginSuccess ?? '')
      label.textContent = successLabel
      celebrate()
      // 主进程已把设备令牌落盘；等彩带播完再放行启动流程。
      window.setTimeout(() => { void api.complete?.() }, CONFETTI_DURATION_MS * 0.6)
      return
    }
    showError(result?.message ?? 'Sign-in failed')
  } catch (error) {
    showError(String(error))
  }
  button.disabled = false
  $('spinner').hidden = true
  label.textContent = submitLabel
})

init()
