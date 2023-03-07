import { NorthConnectorManifest } from '../../../../shared/model/north-connector.model';

const manifest: NorthConnectorManifest = {
  name: 'FileWriter',
  category: 'file',
  description: 'FileWriter description',
  modes: {
    files: true,
    points: true
  },
  settings: [
    {
      key: 'outputFolder',
      type: 'OibText',
      label: 'Output folder',
      defaultValue: './output',
      newRow: true,
      validators: [{ key: 'required' }]
    },
    {
      key: 'prefixFileName',
      type: 'OibText',
      label: 'Prefix',
      defaultValue: '',
      newRow: true,
      validators: [
        { key: 'minLength', params: { minLength: 1 } },
        { key: 'maxLength', params: { maxLength: 255 } }
      ]
    },
    {
      key: 'suffixFileName',
      type: 'OibText',
      label: 'Suffix',
      defaultValue: '',
      newRow: false,
      validators: [
        { key: 'minLength', params: { minLength: 1 } },
        { key: 'maxLength', params: { maxLength: 255 } }
      ]
    }
  ]
};
export default manifest;
