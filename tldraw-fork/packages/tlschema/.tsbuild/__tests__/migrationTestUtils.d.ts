import { MigrationId } from '@tldraw/store';
export declare const testSchema: import("..").TLSchema;
export declare function getTestMigration(migrationId: MigrationId): {
    id: `${string}/${number}`;
    up: (stuff: any) => any;
    down: (stuff: any) => any;
};
//# sourceMappingURL=migrationTestUtils.d.ts.map