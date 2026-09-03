import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { form, FormField, required, submit } from '@angular/forms/signals';
import { UserRole } from '../types';
import { VivaceService } from './vivace.service';

interface LoginModel {
  username: string;
  password: string;
  rememberMe: boolean;
}

@Component({
  selector: 'vivace-auth',
  standalone: true,
  imports: [FormField],
  templateUrl: './auth.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AuthComponent {
  readonly vivace = inject(VivaceService);
  readonly tab = signal<UserRole>('professional');
  readonly showPassword = signal(false);
  readonly loginModel = signal<LoginModel>({
    username: 'Rafaely Carvalho',
    password: 'vivace-demo',
    rememberMe: true
  });
  readonly loginForm = form(this.loginModel, path => {
    required(path.username, { message: 'Informe o usuário.' });
    required(path.password, { message: 'Informe a senha.' });
  });

  selectTab(role: UserRole): void {
    this.tab.set(role);
    this.loginModel.update(model => ({
      ...model,
      username: role === 'professional' ? 'Rafaely Carvalho' : role === 'patient' ? 'mariana' : 'admin'
    }));
  }

  login(event: Event): void {
    event.preventDefault();
    void submit(this.loginForm, async () => {
      this.vivace.loginAs(this.tab(), this.tab() === 'patient' ? 'pat-1' : undefined);
    });
  }
}
