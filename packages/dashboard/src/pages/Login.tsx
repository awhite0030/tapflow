import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTheme } from 'next-themes'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FieldError } from '@/components/ui/field-error'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})
type FormData = z.infer<typeof schema>

export function Login() {
  const navigate = useNavigate()
  const { resolvedTheme } = useTheme()
  const defaultLogo = resolvedTheme === 'dark' ? '/logo-dark.svg' : '/logo.svg'

  useEffect(() => {
    fetch('/api/v1/auth/status')
      .then((r) => r.json() as Promise<{ initialized: boolean }>)
      .then(({ initialized }) => { if (!initialized) navigate('/setup', { replace: true }) })
      .catch(() => {})
  }, [navigate])

  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
  })

  async function onSubmit(data: FormData) {
    try {
      const { status } = await api.post('/api/v1/auth/login', { email: data.email, password: data.password })
      if (status !== 200) { setError('root', { message: 'Invalid email or password' }); return }
      navigate('/app-center', { replace: true })
    } catch {
      setError('root', { message: 'Network error. Please try again.' })
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center overflow-hidden p-4">
      <div className="flex flex-col items-center gap-6 w-full max-w-sm">
        <div className="flex items-center gap-2">
          <img src={defaultLogo} alt="tapflow" className="w-6 h-6" />
          <span className="text-base font-semibold tracking-tight">tapflow</span>
        </div>
        <Card level={4} className="w-full">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl tracking-display-md">Welcome back</CardTitle>
          <CardDescription>Sign in to your team workspace</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@company.com"
                autoComplete="email"
                aria-required="true"
                aria-invalid={!!errors.email}
                aria-describedby={errors.email ? 'email-error' : undefined}
                {...register('email')}
              />
              <FieldError id="email-error" message={errors.email?.message} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                aria-required="true"
                aria-invalid={!!errors.password}
                aria-describedby={errors.password ? 'password-error' : undefined}
                {...register('password')}
              />
              <FieldError id="password-error" message={errors.password?.message} />
            </div>
            <FieldError assertive id="login-error" message={errors.root?.message} />
            <Button type="submit" size="lg" disabled={isSubmitting} className="w-full mt-1">
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
        </Card>
      </div>
    </div>
  )
}
