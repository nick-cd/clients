import { Injectable } from "@angular/core";
import { Subject } from "rxjs";

import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { CryptoService } from "@bitwarden/common/abstractions/crypto.service";
import { CryptoFunctionService } from "@bitwarden/common/abstractions/cryptoFunction.service";
import { EncryptService } from "@bitwarden/common/abstractions/encrypt.service";
import { Utils } from "@bitwarden/common/misc/utils";
import { EncString } from "@bitwarden/common/models/domain/enc-string";
import { SymmetricCryptoKey } from "@bitwarden/common/models/domain/symmetric-crypto-key";
import { ListResponse } from "@bitwarden/common/models/response/list.response";

import { AccessTokenRequest } from "../models/requests/access-token.request";
import { AccessTokenCreationResponse } from "../models/responses/access-token-creation.response";
import { AccessTokenResponse } from "../models/responses/access-tokens.response";
import { AccessTokenView } from "../models/view/access-token.view";

@Injectable({
  providedIn: "root",
})
export class AccessService {
  private readonly _accessTokenVersion = "0";
  protected _accessToken: Subject<AccessTokenView> = new Subject();

  accessToken$ = this._accessToken.asObservable();

  constructor(
    private cryptoService: CryptoService,
    private apiService: ApiService,
    private cryptoFunctionService: CryptoFunctionService,
    private encryptService: EncryptService
  ) {}

  async getAccessTokens(
    organizationId: string,
    serviceAccountId: string
  ): Promise<AccessTokenView[]> {
    const r = await this.apiService.send(
      "GET",
      "/service-accounts/" + serviceAccountId + "/access-tokens",
      null,
      true,
      true
    );
    const results = new ListResponse(r, AccessTokenResponse);

    return await this.createAccessTokenViews(organizationId, results.data);
  }

  async createAccessToken(
    organizationId: string,
    serviceAccountId: string,
    accessTokenView: AccessTokenView
  ): Promise<string> {
    const keyMaterial = await this.cryptoFunctionService.randomBytes(16);
    const key = await this.cryptoFunctionService.hkdf(
      keyMaterial,
      "bitwarden-accesstoken",
      "sm-access-token",
      64,
      "sha256"
    );
    const encryptionKey = new SymmetricCryptoKey(key);

    const request = await this.createAccessTokenRequest(
      organizationId,
      encryptionKey,
      accessTokenView
    );
    const r = await this.apiService.send(
      "POST",
      "/service-accounts/" + serviceAccountId + "/access-tokens",
      request,
      true,
      true
    );
    const result = new AccessTokenCreationResponse(r);
    this._accessToken.next(null);
    const b64Key = Utils.fromBufferToB64(keyMaterial);
    return `${this._accessTokenVersion}.${result.id}.${result.clientSecret}:${b64Key}`;
  }

  private async createAccessTokenRequest(
    organizationId: string,
    encryptionKey: SymmetricCryptoKey,
    accessTokenView: AccessTokenView
  ): Promise<AccessTokenRequest> {
    const organizationKey = await this.getOrganizationKey(organizationId);
    const accessTokenRequest = new AccessTokenRequest();
    const [name, encryptedPayload, key] = await Promise.all([
      await this.encryptService.encrypt(accessTokenView.name, organizationKey),
      await this.encryptService.encrypt(
        JSON.stringify({ encryptionKey: organizationKey.keyB64 }),
        encryptionKey
      ),
      await this.encryptService.encrypt(encryptionKey.keyB64, organizationKey),
    ]);

    accessTokenRequest.name = name;
    accessTokenRequest.encryptedPayload = encryptedPayload;
    accessTokenRequest.key = key;
    accessTokenRequest.expireAt = accessTokenView.expireAt;
    return accessTokenRequest;
  }

  private async getOrganizationKey(organizationId: string): Promise<SymmetricCryptoKey> {
    return await this.cryptoService.getOrgKey(organizationId);
  }

  private async createAccessTokenViews(
    organizationId: string,
    accessTokenResponses: AccessTokenResponse[]
  ): Promise<AccessTokenView[]> {
    const orgKey = await this.getOrganizationKey(organizationId);
    return await Promise.all(
      accessTokenResponses.map(async (s) => {
        const view = new AccessTokenView();
        view.id = s.id;
        view.name = await this.encryptService.decryptToUtf8(new EncString(s.name), orgKey);
        view.scopes = s.scopes;
        view.expireAt = s.expireAt ? new Date(s.expireAt) : null;
        view.creationDate = new Date(s.creationDate);
        view.revisionDate = new Date(s.revisionDate);
        return view;
      })
    );
  }
}
