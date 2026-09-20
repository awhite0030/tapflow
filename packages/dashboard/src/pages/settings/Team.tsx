import { useEffect, useId, useRef, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FieldError } from '@/components/ui/field-error'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { joinPath, loadTeammateBases } from '@/lib/publicLink'

type Member = { id: number; email: string; display_name: string; role: string; joined_at: string }

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.string().min(1),
})
type InviteData = z.infer<typeof inviteSchema>

const inviteResponseSchema = z.object({
  token: z.string(),
  emailSent: z.boolean(),
  inviteUrl: z.string().nullable(),
})

export function TeamSettings() {
  const [members, setMembers] = useState<Member[]>([])
  const [resetSent, setResetSent] = useState<Record<number, string>>({})
  const [inviteLink, setInviteLink] = useState('')
  const [linkCopied, setLinkCopied] = useState(false)
  const [inviteStatus, setInviteStatus] = useState('')
  const linkLabelId = useId()
  const linkRef = useRef<HTMLInputElement>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null)

  const { register, handleSubmit, control, reset, formState: { errors, isSubmitting } } = useForm<InviteData>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: '', role: 'QA' },
  })

  function load() {
    fetch('/api/v1/team/members', { credentials: 'include' }).then((r) => r.json()).then(setMembers)
  }

  useEffect(() => { load() }, [])

  // The form and the button that had focus are replaced by the link. Focus goes to the link, where it can be
  // selected and copied by hand — the only way on a plain-HTTP page, which has no clipboard API.
  useEffect(() => { if (inviteLink) linkRef.current?.focus() }, [inviteLink])

  async function onInvite(data: InviteData) {
    // Cleared first, so a retry that fails the same way is announced again.
    setInviteStatus('')
    try {
      const res = await fetch('/api/v1/team/invite', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: data.email, role: data.role }),
      })
      if (!res.ok) throw new Error(`Server error: ${res.status}`)
      const json = inviteResponseSchema.parse(await res.json())
      // The relay returns the link it mailed (#788). It has none to offer when its only address is one a
      // teammate cannot open, and then the link is built from the teammate base.
      const link = json.inviteUrl ?? joinPath((await loadTeammateBases()).linkBase, `/invite?token=${json.token}`)
      // A plain-HTTP page has no clipboard API. That is a copy that did not happen, not a failed invite.
      const copied = await (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject(new Error('no clipboard')))
        .then(() => true, () => false)
      setInviteLink(link)
      setLinkCopied(copied)
      // Toasts render outside the dialog, and an open dialog hides everything outside it from assistive
      // technology, so the outcome is also said inside the dialog.
      setInviteStatus(`${json.emailSent ? `Invite email sent to ${data.email}.` : 'Email could not be sent.'} ${copied ? 'Invite link copied to clipboard.' : 'Copy the invite link.'}`)
      if (json.emailSent) {
        toast.success(`Invite email sent to ${data.email}`)
      } else if (copied) {
        toast.warning('Invite link copied — email could not be sent. Check your SMTP settings.')
      } else {
        toast.warning('Email could not be sent. Copy the invite link from the dialog, and check your SMTP settings.')
      }
    } catch {
      toast.error('Failed to create invite link')
      setInviteStatus('Failed to create invite link.')
    }
  }

  function handleDialogClose(open: boolean) {
    setInviteOpen(open)
    if (!open) { setInviteLink(''); setLinkCopied(false); setInviteStatus(''); reset() }
  }

  async function handleRoleChange(id: number, role: string) {
    await fetch(`/api/v1/team/members/${id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    })
    load()
  }

  async function handleSendReset(id: number) {
    const res = await fetch(`/api/v1/team/members/${id}/send-reset`, { method: 'POST', credentials: 'include' })
    const data = await res.json() as { emailSent: boolean }
    const msg = data.emailSent ? 'Sent' : 'No SMTP'
    setResetSent((p) => ({ ...p, [id]: msg }))
    setTimeout(() => setResetSent((p) => { const n = { ...p }; delete n[id]; return n }), 3000)
  }

  async function handleDelete(id: number) {
    await fetch(`/api/v1/team/members/${id}`, { method: 'DELETE', credentials: 'include' })
    setPendingDeleteId(null)
    load()
  }

  return (
    <div className="flex flex-col gap-6 max-w-[900px] mx-auto w-full p-6">
      <AlertDialog open={pendingDeleteId !== null} onOpenChange={(open) => { if (!open) setPendingDeleteId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this member?</AlertDialogTitle>
            <AlertDialogDescription>
              This member will lose access to the team immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive/10 text-destructive hover:bg-destructive/20 border-0"
              onClick={() => pendingDeleteId !== null && handleDelete(pendingDeleteId)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Team</h1>
        <Dialog open={inviteOpen} onOpenChange={handleDialogClose}>
          <DialogTrigger asChild>
            <Button size="sm"><UserPlus className="mr-2 h-4 w-4" />Invite member</Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader><DialogTitle>Invite team member</DialogTitle></DialogHeader>
            {/* Mounted before the outcome arrives, so the change is announced. */}
            <p role="status" className="sr-only">{inviteStatus}</p>
            {inviteLink ? (
              <div className="flex flex-col gap-3 pt-2">
                <p id={linkLabelId} className="text-sm text-muted-foreground">{linkCopied ? 'Invite link copied to clipboard:' : 'Copy this invite link:'}</p>
                <Input ref={linkRef} readOnly value={inviteLink} aria-labelledby={linkLabelId} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
                <Button onClick={() => handleDialogClose(false)}>Done</Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit(onInvite)} className="flex flex-col gap-4 pt-2">
                <div className="grid gap-2">
                  <Label htmlFor="invite-email">Email</Label>
                  <Input id="invite-email" type="email"aria-required="true" aria-invalid={!!errors.email} aria-describedby={errors.email ? 'email-error' : undefined} {...register('email')} />
                  <FieldError id="email-error" message={errors.email?.message} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="invite-role">Role</Label>
                  <Controller
                    name="role"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id="invite-role"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Admin">Admin</SelectItem>
                          <SelectItem value="Developer">Developer</SelectItem>
                          <SelectItem value="QA">QA</SelectItem>
                          <SelectItem value="Viewer">Viewer</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
                <Button type="submit" disabled={isSubmitting}>{isSubmitting ? 'Creating link…' : 'Generate invite link'}</Button>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader><CardTitle>Members ({members.length})</CardTitle></CardHeader>
        <CardContent className="px-4 pt-0 pb-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nickname</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.id} className="hover:bg-transparent">
                  <TableCell className="font-medium">{m.display_name || '—'}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{m.email}</TableCell>
                  <TableCell>
                    <Select value={m.role} onValueChange={(r) => handleRoleChange(m.id, r)}>
                      <SelectTrigger className="h-7 w-28"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Admin">Admin</SelectItem>
                        <SelectItem value="Developer">Developer</SelectItem>
                        <SelectItem value="QA">QA</SelectItem>
                        <SelectItem value="Viewer">Viewer</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {new Date(m.joined_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button variant="secondary" size="nav" onClick={() => handleSendReset(m.id)}>
                        {resetSent[m.id] ?? 'Reset pwd'}
                      </Button>
                      <Button variant="destructive" size="nav" onClick={() => setPendingDeleteId(m.id)}>
                        Remove
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
