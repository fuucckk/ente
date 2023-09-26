package pkg

import (
	"cli-go/internal/api"
	enteCrypto "cli-go/internal/crypto"
	"cli-go/pkg/model"
	"cli-go/utils/encoding"
	"context"
	"encoding/json"
	"errors"
	"log"
)

func (c *ClICtrl) mapCollectionToAlbum(ctx context.Context, collection api.Collection) (*model.RemoteAlbum, error) {
	var album model.RemoteAlbum
	userID := ctx.Value("user_id").(int64)
	album.OwnerID = collection.Owner.ID
	album.ID = collection.ID
	album.IsShared = collection.Owner.ID != userID
	album.LastUpdatedAt = collection.UpdationTime
	album.IsDeleted = collection.IsDeleted
	collectionKey, err := c.KeyHolder.GetCollectionKey(ctx, collection)
	if err != nil {
		return nil, err
	}
	album.AlbumKey = *model.MakeEncString(collectionKey, c.CliKey)
	var name string
	if collection.EncryptedName != "" {
		decrName, err := enteCrypto.SecretBoxOpenBase64(collection.EncryptedName, collection.NameDecryptionNonce, collectionKey)
		if err != nil {
			log.Fatalf("failed to decrypt collection name: %v", err)
		}
		name = string(decrName)
	} else {
		// Early beta users (friends & family) might have collections without encrypted names
		name = collection.Name
	}
	album.AlbumName = name
	if collection.MagicMetadata != nil {
		_, encodedJsonBytes, err := enteCrypto.DecryptChaChaBase64(collection.MagicMetadata.Data, collectionKey, collection.MagicMetadata.Header)
		if err != nil {
			return nil, err
		}
		err = json.Unmarshal(encodedJsonBytes, &album.PrivateMeta)
		if err != nil {
			return nil, err
		}
	}
	if collection.PublicMagicMetadata != nil {
		_, encodedJsonBytes, err := enteCrypto.DecryptChaChaBase64(collection.PublicMagicMetadata.Data, collectionKey, collection.PublicMagicMetadata.Header)
		if err != nil {
			return nil, err
		}
		err = json.Unmarshal(encodedJsonBytes, &album.PublicMeta)
		if err != nil {
			return nil, err
		}
	}
	if album.IsShared && collection.SharedMagicMetadata != nil {
		_, encodedJsonBytes, err := enteCrypto.DecryptChaChaBase64(collection.SharedMagicMetadata.Data, collectionKey, collection.SharedMagicMetadata.Header)
		if err != nil {
			return nil, err
		}
		err = json.Unmarshal(encodedJsonBytes, &album.SharedMeta)
		if err != nil {
			return nil, err
		}
	}
	return &album, nil
}

func (c *ClICtrl) mapApiFileToPhotoFile(ctx context.Context, album model.RemoteAlbum, file api.File) (*model.RemoteFile, error) {
	if file.IsDeleted {
		return nil, errors.New("file is deleted")
	}
	albumKey := album.AlbumKey.MustDecrypt(c.CliKey)
	fileKey, err := enteCrypto.SecretBoxOpen(
		encoding.DecodeBase64(file.EncryptedKey),
		encoding.DecodeBase64(file.KeyDecryptionNonce),
		albumKey)
	if err != nil {
		return nil, err
	}
	var photoFile model.RemoteFile
	photoFile.ID = file.ID
	photoFile.LastUpdateTime = file.UpdationTime
	photoFile.Key = *model.MakeEncString(fileKey, c.CliKey)
	photoFile.FileNonce = file.File.DecryptionHeader
	photoFile.ThumbnailNonce = file.Thumbnail.DecryptionHeader
	photoFile.OwnerID = file.OwnerID
	if file.Info != nil {
		photoFile.Info = model.Info{
			FileSize:      file.Info.FileSize,
			ThumbnailSize: file.Info.ThumbnailSize,
		}
	}
	if file.Metadata.DecryptionHeader != "" {
		_, encodedJsonBytes, err := enteCrypto.DecryptChaChaBase64(file.Metadata.EncryptedData, fileKey, file.Metadata.DecryptionHeader)
		if err != nil {
			return nil, err
		}
		err = json.Unmarshal(encodedJsonBytes, &photoFile.Metadata)
		if err != nil {
			return nil, err
		}
	}
	if file.MagicMetadata != nil {
		_, encodedJsonBytes, err := enteCrypto.DecryptChaChaBase64(file.MagicMetadata.Data, fileKey, file.MagicMetadata.Header)
		if err != nil {
			return nil, err
		}
		err = json.Unmarshal(encodedJsonBytes, &photoFile.PrivateMetadata)
		if err != nil {
			return nil, err
		}
	}
	if file.PubicMagicMetadata != nil {
		_, encodedJsonBytes, err := enteCrypto.DecryptChaChaBase64(file.PubicMagicMetadata.Data, fileKey, file.PubicMagicMetadata.Header)
		if err != nil {
			return nil, err
		}
		err = json.Unmarshal(encodedJsonBytes, &photoFile.PublicMetadata)
		if err != nil {
			return nil, err
		}
	}
	return &photoFile, nil

}
