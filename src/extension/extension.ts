import Browser from 'webextension-polyfill';
import {
  type ExtensionConfig,
  type UserData,
  type AppData,
  type ExtensionData,
  type ExtensionSettings,
  type IamRole,
  CustomData,
  ExtensionPermissions,
  UserConfig,
  ContextualIdentity,
} from '../types';

function encodeUriPlusParens(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
}

class Extension {
  config: ExtensionConfig;

  platform: 'chrome' | 'firefox' | 'safari';

  consoleUrlRegex: RegExp;

  ssoUrl: string;

  apps: AppData[];

  loaded: boolean;

  defaultCustom = {
    accounts: {},
    accountsOverride: false,
    displayName: '',
    sessionLabelSso: '{{user}}/{{profile}} @ {{account}}',
    sessionLabelIam: '{{user}}/{{role}} @ {{account}} via {{profile}}',
    colorDefault: '222f3e',
    colorFooter: true, // confusing if these are disabled
    colorHeader: true, // after granting permissions
    labelFooter: true,
    labelHeader: true,
    labelIcon: false,
    profiles: {},
    hotkeys: {
      openProfile1: '',
      openProfile2: '',
      openProfile3: '',
    },
  };

  defaultSettings = {
    defaultUser: 'lastUserId',
    enableSync: true,
    lastUserId: null,
    lastProfileId: null,
    firefoxContainers: false,
    firefoxResumeContainer: true,
    firefoxExpireMinsContainer: 480,
    iconColor: 'red',
    navCurrentTab: false,
    showReleaseNotes: true,
    showAllProfiles: false,
    tableSettings: {
      showAllUsers: false,
      showIamRoles: true,
      showIcon: true,
      sortCustom: false,
      sortApp: 'desc',
      sortProfile: false,
    },
  };

  constructor(config: ExtensionConfig) {
    this.config = config;
    this.platform = this.checkPlatform();
    this.consoleUrlRegex = /^https:\/\/(((?<region>\w{2}-\w+-\d{1,2})|support|s3|health)\.console\.aws\.amazon|console\.amazonaws-us-gov)\.com\/(?<path>.*)?$/;
    this.ssoUrl = '';
    this.loaded = false;
    this.apps = [];
    this.log(this);
  }

  log(v: unknown): void {
    if (this.config.debug) {
      if (typeof v !== 'string') {
        // eslint-disable-next-line no-console
        console.log(v);
      } else {
        // eslint-disable-next-line no-console
        console.log(`${this.config.name}:${v}`);
      }
    }
  }

  checkPlatform() {
    this.log(`checkPlatform:${navigator.userAgent}`);
    if (navigator.userAgent.indexOf('Firefox') !== -1) {
      return 'firefox';
    }
    if (navigator.userAgent.indexOf('Chrome') !== -1) {
      return 'chrome';
    }
    if (navigator.userAgent.indexOf('Safari') !== -1) {
      return 'safari';
    }
    return 'chrome';
  }

  buildLabel(s, user, profile, role, account, accountName, accounts): string {
    let label = s;
    // apply profile settings
    if (user) {
      label = label.replaceAll('{{user}}', user);
    }
    if (role) {
      label = label.replaceAll('{{role}}', role);
    }
    if (profile) {
      label = label.replaceAll('{{profile}}', profile);
    }
    if (account) {
      label = label.replaceAll('{{account}}', account);
    }
    if (accountName) {
      let accountLabel = accountName;
      if (accounts[account] !== undefined) {
        if (accounts[account].label) {
          accountLabel = accounts[account].label;
        }
      }
      label = label.replaceAll('{{accountName}}', accountLabel);
    }
    return label;
  }

  async checkPermissions(): Promise<ExtensionPermissions> {
    this.log('checkPermissions');
    const history = this.platform === 'safari'
      ? Promise.resolve(false)
      : this.config.browser.permissions.contains({
        permissions: ['history'],
      });
    const console = this.config.browser.permissions.contains({
      origins: [...this.config.permissions.console],
    });
    const signin = this.config.browser.permissions.contains({
      origins: [...this.config.permissions.signin],
    });
    const sso = this.config.browser.permissions.contains({
      origins: [...this.config.permissions.sso],
    });
    const containers = this.platform === 'firefox'
      ? this.config.browser.permissions.contains({
        origins: [...this.config.permissions.containers],
        permissions: [
          'activeTab',
          'webRequest',
          'webRequestBlocking',
          'webRequestFilterResponse',
        ],
      })
      : Promise.resolve(false);
    // eslint-disable-next-line vue/max-len
    const data = await Promise.all([
      history,
      console,
      signin,
      sso,
      containers,
    ]).then((res) => ({
      history: res[0],
      console: res[1],
      signin: res[2],
      sso: res[3],
      containers: res[4],
    }));
    this.log(data);
    return data;
  }

  async loadIamLogins(): Promise<IamRole[]> {
    const loginsKey = `${this.config.name}-iam-logins`;
    const loginsData = await this.config.browser.storage.local.get(loginsKey);
    const logins = loginsData[loginsKey] === undefined
      ? {}
      : JSON.parse(loginsData[loginsKey]);
    return logins;
  }

  async removeIamLogin(profileId: string): Promise<void> {
    this.log(`removeIamLogin:${profileId}`);
    const logins = await this.loadIamLogins();
    delete logins[profileId];
    this.log(logins);
    return this.saveData(
      `${this.config.name}-iam-logins`,
      logins,
      this.config.browser.storage.local,
    );
  }

  queueIamLogin(role: IamRole): Promise<void> {
    this.log('queueIamLogin');
    return this.loadIamLogins().then((logins) => {
      const iamLogins = logins;
      iamLogins[role.profileId] = role;
      this.saveData(
        `${this.config.name}-iam-logins`,
        iamLogins,
        this.config.browser.storage.local,
      );
    });
  }

  async loadUser(
    userId: string,
    enableSync: ExtensionSettings['enableSync'],
  ): Promise<UserData> {
    const storage = enableSync
      ? this.config.browser.storage.sync
      : this.config.browser.storage.local;
    const userKey = `${this.config.name}-user-${userId}`;
    const userData = await storage.get(userKey);
    const user = userData[userKey] === undefined ? {} : JSON.parse(userData[userKey]);
    const customKey = `${this.config.name}-custom-${userId}`;
    const customData = await storage.get(customKey);
    // eslint-disable-next-line vue/max-len
    const custom = customData[customKey] === undefined
      ? this.defaultCustom
      : JSON.parse(customData[customKey]);
    Object.keys(this.defaultCustom).forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(custom, key)) {
        custom[key] = this.defaultCustom[key];
      }
    });
    user.custom = custom;
    return user as UserData;
  }

  async loadUsers(
    enableSync: ExtensionSettings['enableSync'],
  ): Promise<UserData[]> {
    const users: Array<Promise<UserData>> = [];
    const usersKey = `${this.config.name}-users`;
    // keep users list in sync
    const usersData = await this.config.browser.storage.sync.get(usersKey);
    const userIds = usersData[usersKey] === undefined
      ? []
      : JSON.parse(usersData[usersKey]).users;
    // enableSync determines where user data (customizations) are stored
    userIds.forEach((userId: string) => {
      users.push(this.loadUser(userId, enableSync));
    });
    await Promise.all(users);
    const data = await Promise.all(users).then((x) => x);
    return data;
  }

  async saveSettings(settings: ExtensionSettings): Promise<void> {
    await this.saveData(
      `${this.config.name}-settings`,
      settings,
      this.config.browser.storage.sync,
    );
  }

  async loadSettings(): Promise<ExtensionSettings> {
    this.log('loadSettings');
    const setKey = `${this.config.name}-settings`;
    const setData = await this.config.browser.storage.sync.get(setKey);
    // eslint-disable-next-line vue/max-len
    const settings = setData[setKey] === undefined
      ? this.defaultSettings
      : JSON.parse(setData[setKey]);
    // replace missing settings with default settings
    // useful when adding new settings between versions
    Object.keys(this.defaultSettings).forEach((key) => {
      // no key or undefined
      if (!Object.prototype.hasOwnProperty.call(settings, key)) {
        settings[key] = this.defaultSettings[key];
      }
    });
    return settings as ExtensionSettings;
  }

  getDefaultUser(data: ExtensionData): UserData {
    this.log('getDefaultUser');
    if (data.settings.defaultUser === 'lastUserId') {
      const lastUser = data.users.find((u) => u.userId === data.settings.lastUserId);
      return lastUser || data.users[0];
    }
    return data.users.filter((u) => u.userId === data.settings.defaultUser)[0];
  }

  async loadData(): Promise<ExtensionData> {
    this.log('loadData');
    const iamLogins = await this.loadIamLogins();
    const settings = await this.loadSettings();
    let users = await this.loadUsers(settings.enableSync);
    users = users.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
    const appProfileIds = users.map((u) => u.appProfileIds);
    const uniqProfileIds = [...new Set(appProfileIds.flat(1))];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const appProfiles: Array<Promise<Record<string, any>>> = [];
    // load app profiles
    uniqProfileIds.forEach((apId) => {
      appProfiles.push(this.config.browser.storage.local.get(apId));
    });
    const data = await Promise.all(appProfiles).then((aps) => ({
      updatedAt: users.length > 0 ? users[0].updatedAt : 0,
      appProfiles: aps
        .filter((ap) => ap[Object.keys(ap)[0]] !== undefined)
        .map((ap) => JSON.parse(ap[Object.keys(ap)[0]])),
      settings,
      users,
      iamLogins,
    }));
    this.log(data);
    return data;
  }

  async createProfileUrl(user: UserData, appProfile: AppData): Promise<string> {
    console.log('createProfileUrl');
    const ssoDirUrl = `https://${user.managedActiveDirectoryId}.awsapps.com/start/#/saml`;
    const appProfileName = encodeUriPlusParens(appProfile.name);

    if (appProfile.profile.name === 'Default') {
      return `${ssoDirUrl}/default/${appProfileName}/${appProfile.id}`;
    }

    let consoleUrl = `https://${user.managedActiveDirectoryId}.awsapps.com/start/#/console?account_id=${appProfile.searchMetadata?.AccountId}&role_name=${appProfile.profile.name}`;

    const currentTab = (await this.config.browser.tabs.query({currentWindow: true, active: true}))[0];
    // if the current tab in the console, specify the destination
    if (currentTab.url?.match(this.consoleUrlRegex)) {
      consoleUrl = `${consoleUrl}&destination=${encodeURIComponent(currentTab.url)}`;
    }

    return consoleUrl;
  }

  parseAppProfiles(): AppData[] {
    const appProfiles: AppData[] = [];
    this.apps.forEach((app) => {
      app.profiles?.forEach((profile) => {
        const appProfile = {
          ...app,
          profile,
        };
        delete appProfile.profiles;
        appProfiles.push(appProfile);
      });
    });
    return appProfiles;
  }

  async resetData(): Promise<void> {
    this.log('resetData');
    await this.config.browser.storage.sync.clear();
    await this.config.browser.storage.local.clear();
  }

  async removeUser(userId: string, enableSync: boolean): Promise<void> {
    this.log(`removeUser: ${userId}`);
    
    // Load user to get appProfileIds
    const user = await this.loadUser(userId, enableSync);
    if (!user) {
      this.log(`User ${userId} not found`);
      return;
    }
    
    // Remove user-specific storage keys
    const storage = enableSync ? this.config.browser.storage.sync : this.config.browser.storage.local;
    await storage.remove([
      `${this.config.name}-user-${userId}`,
      `${this.config.name}-custom-${userId}`
    ]);
    
    // Remove associated app profiles
    if (user.appProfileIds && user.appProfileIds.length > 0) {
      await this.config.browser.storage.local.remove(user.appProfileIds);
    }
    
    // Remove IAM logins for user's profiles
    const iamLogins = await this.loadIamLogins();
    if (user.appProfileIds) {
      user.appProfileIds.forEach(profileId => {
        delete iamLogins[profileId];
      });
      await this.saveData(`${this.config.name}-iam-logins`, iamLogins, this.config.browser.storage.local);
    }
    
    // Remove user from users list
    const usersData = await this.config.browser.storage.sync.get(`${this.config.name}-users`);
    const users = usersData[`${this.config.name}-users`] ? JSON.parse(usersData[`${this.config.name}-users`]).users : [];
    const updatedUsers = users.filter((id: string) => id !== userId);
    await this.saveData(`${this.config.name}-users`, { users: updatedUsers }, this.config.browser.storage.sync);
    
    // Update settings if this was the default/last user
    const settings = await this.loadSettings();
    if (settings.defaultUser === userId || settings.lastUserId === userId) {
      settings.lastUserId = updatedUsers[0] || '';
      if (settings.defaultUser === userId) {
        settings.defaultUser = 'lastUserId';
      }
      await this.saveSettings(settings);
    }
  }

  async saveData(
    dataKey: string,
    data: unknown,
    db: Browser.Storage.LocalStorageArea | Browser.Storage.SyncStorageAreaSync,
  ): Promise<void> {
    this.log(`saveData:${dataKey}`);
    this.log(data);
    const dataObj = {};
    dataObj[dataKey] = JSON.stringify(
      typeof data === 'object' ? { ...data, updatedAt: Date.now() } : data,
    );
    await db.set(dataObj);
  }

  saveCustom(custom: UserData['custom'], userId: UserData['userId'], enableSync: ExtensionSettings['enableSync']): void {
    this.saveData(
      `${this.config.name}-custom-${userId}`,
      custom,
      enableSync ? this.config.browser.storage.sync : this.config.browser.storage.local,
    );
  }

  saveUser(
    user: UserData,
    enableSync: ExtensionSettings['enableSync'],
  ): Promise<void> {
    if ('custom' in user) {
      this.saveCustom(user.custom, user.userId, enableSync);
    }
    return this.saveData(
      `${this.config.name}-user-${user.userId}`,
      { ...user, custom: {} },
      enableSync ? this.config.browser.storage.sync : this.config.browser.storage.local,
    );
  }

  saveAppProfiles(user: UserData, enableSync: ExtensionSettings['enableSync']): void {
    this.log('saveAppProfiles');
    const appProfiles = this.parseAppProfiles();
    appProfiles.forEach((appProfile) => {
      this.saveData(
        appProfile.profile?.id,
        appProfile,
        this.config.browser.storage.local,
      );
    });
    const appProfileIds = appProfiles.map((ap) => ap.profile?.id);
    const data = { ...user, appProfileIds };
    this.saveUser(data, enableSync);
  }

  customizeProfiles(
    user: UserData,
    appProfiles: AppData[],
  ): AppData[] {
    this.log('customizeProfiles');
    const defaults: CustomData = {
      favorite: false,
      hide: false,
      label: null,
      iamRoles: [] as IamRole[],
      color: user.custom.colorDefault
    };

    const customProfiles: AppData[] = [];
    appProfiles.forEach((ap) => {
      let profile = ap;
      // eslint-disable-next-line max-len, vue/max-len
      profile.profile.custom = ap.profile.id in user.custom.profiles
        ? user.custom.profiles[ap.profile.id]
        : defaults as CustomData;
      // inherit or override account color
      if (profile.applicationName === 'AWS Account') {
        if (profile.searchMetadata?.AccountId! in user.custom.accounts) {
          if (user.custom.accountsOverride || profile.profile.custom.color === user.custom.colorDefault) {
            profile.profile.custom = {
              ...profile.profile.custom,
              color: user.custom.accounts[ap.searchMetadata?.AccountId!].color,
            };
          }
        }
      }
      customProfiles.push(profile);
    });
    this.log(user);
    this.log(customProfiles);
    return customProfiles;
  }

  findAppProfile(
    ssoRoleName: string,
    accountId: string,
    data: ExtensionData,
  ): AppData | null {
    this.log('findAppProfile');
    const appProfiles: AppData[] = [];
    const activeUserId = data.users.length === 1 ? data.users[0].userId : data.settings.lastUserId;
    data.users.forEach((user) => {
      if (user.userId === activeUserId) {
        data.appProfiles.forEach((ap) => {
          if (ap.applicationName === 'AWS Account') {
            // sso user, check for matching app profile
            if (
              ap.profile.name === ssoRoleName
              && ap.searchMetadata?.AccountId === accountId
            ) {
              appProfiles.push(this.customizeProfiles(user, [ap])[0]);
            }
          }
        });
      }
    });
    this.log(appProfiles);
    return appProfiles[0];
  }

  findAppProfileByRole(
    iamRole: IamRole,
    user: UserData,
    data: ExtensionData,
  ): AppData {
    // eslint-disable-next-line vue/max-len
    const appProfiles = data!.appProfiles.filter(
      (ap) => ap.profile.id === iamRole?.profileId,
    );
    this.log('findAppProfileByRole');
    this.log(appProfiles);
    return this.customizeProfiles(user, appProfiles)[0];
  }

  findAppProfileById(profileId: string, appProfiles: AppData[]): AppData {
    this.log('findAppProfileById');
    this.log(profileId);
    this.log(appProfiles);
    return appProfiles.filter((ap) => ap.profile.id === profileId)[0];
  }

  findUser(data: ExtensionData): UserData {
    this.log('findUser');
    // eslint-disable-next-line vue/max-len
    const activeUserId = data!.users.length === 1
      ? data!.users[0].userId
      : data!.settings.lastUserId;
    return data!.users.filter((u) => u.userId === activeUserId)[0];
  }

  findUserByProfileId(profileId, users) {
    this.log('findUserByProfileId');
    let user = users[0];
    users.forEach((u) => {
      if ((u as UserData).appProfileIds.includes(profileId)) {
        user = u as UserData;
      }
    });
    return user;
  }

  async update(user: UserData): Promise<void> {
    this.log('updateData');
    await this.loadData().then((data) => {
      const userIds = [user.userId, ...data.users.map((u) => u.userId)];
      // update user list
      this.saveData(
        `${this.config.name}-users`,
        { users: [...new Set(userIds)] },
        this.config.browser.storage.sync,
      );
      this.saveAppProfiles(user, data.settings.enableSync);
    });
  }

  switchRole(label: string, role: IamRole) {
    const roleArgs = [
      `displayName=${label}`,
      `roleName=${role.roleName}`,
      `account=${role.accountId}`,
      `redirect_uri=${encodeURIComponent(
        'https://console.aws.amazon.com/console/home',
      )}`,
    ].join('&');
    // using the url hash, identify when this extension is switching roles
    window.location.href = `https://signin.aws.amazon.com/switchrole?${roleArgs}#${this.config.name}`;
  }

  async navCurrentTab(url: string) {
    this.config.browser.tabs.query({currentWindow: true, active: true}).then((tabs) => {
      this.config.browser.tabs.update(
        tabs[0].id,
        {url: url}
      )
    });
  }

  // eslint-disable-next-line vue/max-len
  async navSelectedProfile(
    profile: AppData,
    user: UserData,
    users: UserData[],
    settings: ExtensionSettings,
  ) {
    let nav = true;
    // eslint-disable-next-line vue/max-len
    if (
      settings.showAllProfiles
      && !user.appProfileIds.includes(profile.profile.id)
    ) {
      // eslint-disable-next-line no-param-reassign
      user = this.findUserByProfileId(profile.profile.id, users);
    }
    this.log('createProfileUrl');
    this.log(user);
    this.log(profile);
    const profileUrl = await this.createProfileUrl(user, profile);
    this.log(profileUrl);
    if (this.platform === 'firefox' && settings.firefoxContainers) {
      let containers: ContextualIdentity[] = [];
      // query existing containers
      if (settings.firefoxResumeContainer) {
        containers = await this.config.browser.contextualIdentities.query({
          name: this.sessionLabelSso(profile, user),
        });
      }
      if (containers.length >= 1) {
        // eslint-disable-next-line vue/max-len
        const tabs = this.config.browser.tabs.query({
          cookieStoreId: containers[0].cookieStoreId,
        });
        // highlight existing tabs
        (await tabs).forEach((tab) => {
          this.config.browser.tabs.highlight({
            windowId: tab.windowId!,
            tabs: tab.index!,
          });
          this.config.browser.windows.update(tab.windowId!, { focused: true });
          // set container expiration
          if (settings.firefoxExpireMinsContainer > 0) {
            this.config.browser.runtime.sendMessage({
              action: 'expireFirefoxContainer',
              cookieStoreId: containers[0].cookieStoreId,
            });
          }
          nav = false;
        });
      }
    }
    if (nav === true) {
      if (settings.navCurrentTab) {
        this.navCurrentTab(profileUrl);
      } else {
        this.config.browser.tabs.create({
          url: profileUrl,
        });
      }
      window.close();
    }
  }

  sessionLabelSso(profile, user) {
    if (profile.applicationName !== 'AWS Account') {
      return profile.profile.custom!.label || profile.profile.name;
    }
    return this.buildLabel(
      user.custom.sessionLabelSso,
      user.custom.displayName || user.subject,
      profile.profile.custom!.label || profile.profile.name,
      null,
      profile.searchMetadata!.AccountId,
      profile.searchMetadata!.AccountName,
      user.custom.accounts,
    );
  }

  importUserConfig(userId: UserData['userId'], cfg: UserConfig): boolean {
    this.log('importUserConfig');
    this.log(cfg);
    try {
      // check top level keys
      let missingKeys = false;
      const requiredKeys = ['user', 'extension'];
      requiredKeys.forEach((key) => {
        if (!(key in cfg)) {
          this.log(`Missing required key: ${key} of ${requiredKeys}`);
          missingKeys = true;
        }
      });
      if (missingKeys) { return false; }
      this.saveSettings(cfg.extension);
      this.saveCustom(cfg.user, userId, cfg.extension.enableSync);
      return true;
    } catch {
      return false;
    }
  }
}

export default Extension;
